// voice-core: CLI and long-lived JSONL sidecar for Phonon-2.5.
//
// `voice-core stream` speaks the v1 protocol on stdin/stdout. Everything
// human-readable goes to stderr; stdout carries only JSONL events.

use std::io::{self, BufRead, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

use voice_core::audio;
use voice_core::engine::{Engine, Segment, Stream};
use voice_core::model::{self, ModelProgress};
use voice_core::protocol::{self, CoreState, Event, ModelState};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const PARTIAL_INTERVAL: Duration = Duration::from_millis(700);
const PARTIAL_MAX_PENDING_SECONDS: f64 = 10.0;
const AUDIO_QUEUE: usize = 2048;
const TRANSCRIBE_CHUNK: usize = 1600;
const ENV_MODEL_DIR: &str = "OPENCODE_VOICE_MODEL_DIR";

const USAGE: &str = "\
voice-core - local streaming voice prompts

Usage:
  voice-core stream
  voice-core transcribe <wav> [--model-dir <dir>] [--json]
  voice-core models status [--model-dir <dir>]
  voice-core models install [--model-dir <dir>]
  voice-core devices
  voice-core --version
  voice-core --help
";

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => std::process::ExitCode::from(code as u8),
        Err(err) => {
            eprintln!("voice-core: {err:#}");
            std::process::ExitCode::from(1)
        }
    }
}

fn run(args: &[String]) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("stream") => {
            if args.len() != 1 {
                return Ok(usage_error("stream takes no arguments"));
            }
            stream_mode()?;
            Ok(0)
        }
        Some("transcribe") => transcribe_cmd(&args[1..]),
        Some("models") => models_cmd(&args[1..]),
        Some("devices") => {
            if args.len() != 1 {
                return Ok(usage_error("devices takes no arguments"));
            }
            devices_cmd()?;
            Ok(0)
        }
        Some("--version") | Some("-V") => {
            println!("voice-core {}", voice_core::VERSION);
            Ok(0)
        }
        Some("--help") | Some("-h") => {
            print!("{}", USAGE);
            Ok(0)
        }
        Some(other) => Ok(usage_error(&format!("unknown command {other:?}"))),
        None => Ok(usage_error("missing command")),
    }
}

fn usage_error(message: &str) -> i32 {
    eprintln!("voice-core: {message}");
    eprintln!();
    eprint!("{}", USAGE);
    2
}

// ---------------------------------------------------------------------------
// Event emitter
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Emitter(Arc<Mutex<BufWriter<io::Stdout>>>);

impl Emitter {
    fn new() -> Self {
        Emitter(Arc::new(Mutex::new(BufWriter::new(io::stdout()))))
    }

    /// Write exactly one compact JSON line and flush it.
    fn emit(&self, event: &Event) {
        match self.0.lock() {
            Ok(mut out) => {
                if let Err(err) = protocol::write_event(&mut *out, event) {
                    eprintln!("voice-core: failed to write an event: {err}");
                }
            }
            Err(_) => eprintln!("voice-core: stdout lock is poisoned"),
        }
    }
}

fn emit_model_progress(emitter: &Emitter, update: ModelProgress) {
    let event = match update {
        ModelProgress::Downloading { received, total } => Event::Model {
            state: ModelState::Downloading,
            received: Some(received),
            total,
        },
        ModelProgress::Extracting => Event::Model {
            state: ModelState::Extracting,
            received: None,
            total: None,
        },
        ModelProgress::Loading => Event::Model {
            state: ModelState::Loading,
            received: None,
            total: None,
        },
        // The engine is only ready once `Engine::open` succeeds.
        ModelProgress::Ready => return,
    };
    emitter.emit(&event);
}

fn model_error_code(err: &anyhow::Error) -> &'static str {
    let message = format!("{err:#}").to_lowercase();
    if message.contains("checksum") {
        "model_checksum"
    } else if message.contains("download") || message.contains("http") {
        "model_download"
    } else if message.contains("extract")
        || message.contains("archive")
        || message.contains("unpack")
        || message.contains("did not contain")
    {
        "model_unpack"
    } else {
        "model_load"
    }
}

// ---------------------------------------------------------------------------
// Stream mode
// ---------------------------------------------------------------------------

fn stream_mode() -> Result<()> {
    let emitter = Emitter::new();
    emitter.emit(&Event::Hello {
        version: voice_core::VERSION.to_string(),
        model: voice_core::MODEL_ID.to_string(),
        platform: platform_key(),
    });

    let (cmd_tx, cmd_rx) = mpsc::channel::<protocol::Command>();

    {
        let shutdown = cmd_tx.clone();
        if let Err(err) = ctrlc::set_handler(move || {
            let _ = shutdown.send(protocol::Command::Shutdown);
        }) {
            // Ctrl+C is a convenience; a missing handler must not stop the sidecar.
            eprintln!("voice-core: could not install the Ctrl+C handler: {err}");
        }
    }

    let session_emitter = emitter.clone();
    let session = std::thread::Builder::new()
        .name("voice-core-session".into())
        .spawn(move || session_loop(session_emitter, cmd_rx))
        .context("spawn the session thread")?;

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();

    loop {
        line.clear();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(err) => {
                eprintln!("voice-core: failed to read stdin: {err}");
                break;
            }
        };
        if read == 0 {
            break;
        }

        let text = line.trim();
        if text.is_empty() {
            continue;
        }

        let command = match protocol::read_command(text) {
            Ok(command) => command,
            Err(err) => {
                emitter.emit(&protocol::error(format!("{err:#}"), "protocol"));
                continue;
            }
        };

        if let protocol::Command::Ping { id } = &command {
            emitter.emit(&Event::Pong { id: *id });
            continue;
        }

        let shutdown = command == protocol::Command::Shutdown;
        if cmd_tx.send(command).is_err() {
            break;
        }
        if shutdown {
            break;
        }
    }

    // EOF, a shutdown command, or a dead session all end at the same place.
    let _ = cmd_tx.send(protocol::Command::Shutdown);
    if session.join().is_err() {
        eprintln!("voice-core: the session thread panicked");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Preparing,
    Listening,
    Transcribing,
}

struct Session {
    emitter: Emitter,
    audio_tx: SyncSender<audio::AudioChunk>,
    audio_rx: Receiver<audio::AudioChunk>,
    engine: Option<Engine>,
    stream: Option<Stream>,
    recorder: Option<audio::Recorder>,
    finals: Vec<Segment>,
    partial: Option<String>,
    phase: Phase,
    done_handled: bool,
    last_partial_at: Instant,
}

impl Session {
    fn new(
        emitter: Emitter,
        audio_tx: SyncSender<audio::AudioChunk>,
        audio_rx: Receiver<audio::AudioChunk>,
    ) -> Self {
        Session {
            emitter,
            audio_tx,
            audio_rx,
            engine: None,
            stream: None,
            recorder: None,
            finals: Vec::new(),
            partial: None,
            phase: Phase::Idle,
            done_handled: false,
            last_partial_at: Instant::now(),
        }
    }

    fn emit_state(&self, state: CoreState) {
        self.emitter.emit(&Event::State { state });
    }

    fn emit_model(&self, state: ModelState) {
        self.emitter.emit(&Event::Model {
            state,
            received: None,
            total: None,
        });
    }

    fn error(&self, err: &anyhow::Error, code: &str) {
        self.emitter
            .emit(&protocol::error(format!("{err:#}"), code));
    }

    fn start(&mut self) {
        if self.phase != Phase::Idle {
            self.emitter.emit(&protocol::error(
                "cannot start while a recording is active",
                "busy",
            ));
            return;
        }

        self.phase = Phase::Preparing;
        self.emit_state(CoreState::Preparing);

        // Audio left over from a cancelled recording must not leak into the new one.
        self.discard_audio();

        let emitter = self.emitter.clone();
        let dir = match model::ensure_model(&mut |update| emit_model_progress(&emitter, update)) {
            Ok(dir) => dir,
            Err(err) => {
                let code = model_error_code(&err);
                self.error(&err, code);
                self.phase = Phase::Idle;
                self.emit_state(CoreState::Idle);
                return;
            }
        };

        if self.engine.is_none() {
            self.emit_model(ModelState::Loading);
            match Engine::open(&dir) {
                Ok(engine) => {
                    self.engine = Some(engine);
                    self.emit_model(ModelState::Ready);
                }
                Err(err) => {
                    self.error(&err, "model_load");
                    self.phase = Phase::Idle;
                    self.emit_state(CoreState::Idle);
                    return;
                }
            }
        }

        let recorder = match audio::start_input(self.audio_tx.clone()) {
            Ok(recorder) => recorder,
            Err(err) => {
                let message = format!("{err:#}").to_lowercase();
                let code = if message.contains("permission") {
                    "permission"
                } else {
                    "no_input"
                };
                self.error(&err, code);
                self.phase = Phase::Idle;
                self.emit_state(CoreState::Idle);
                return;
            }
        };

        let sample_rate = recorder.sample_rate();
        let stream = match self.engine.as_ref() {
            Some(engine) => engine.stream(sample_rate),
            None => Err(anyhow!("engine is not loaded")),
        };

        match stream {
            Ok(stream) => {
                self.recorder = Some(recorder);
                self.stream = Some(stream);
                self.finals.clear();
                self.partial = None;
                self.done_handled = false;
                self.last_partial_at = Instant::now();
                self.phase = Phase::Listening;
                self.emit_state(CoreState::Listening);
            }
            Err(err) => {
                // Dropping the recorder stops capture; no stream was created.
                drop(recorder);
                self.error(&err, "engine");
                self.phase = Phase::Idle;
                self.emit_state(CoreState::Idle);
            }
        }
    }

    fn stop(&mut self) {
        if self.phase != Phase::Listening || self.done_handled {
            return;
        }

        // Stop capture before finalizing so no new audio can arrive.
        self.recorder = None;
        self.phase = Phase::Transcribing;
        self.emit_state(CoreState::Transcribing);

        if let Some(err) = self.drain_audio() {
            self.recover_engine(err);
            return;
        }

        self.emit_segments();

        let finished = match self.stream.as_mut() {
            Some(stream) => stream.finish(),
            None => Ok(0),
        };
        if let Err(err) = finished {
            self.recover_engine(err);
            return;
        }

        self.emit_segments();

        let text = join_transcript(&self.finals, self.partial.as_deref());
        self.emitter.emit(&Event::Done { text });
        self.done_handled = true;

        self.stream = None;
        self.finals.clear();
        self.partial = None;
        self.phase = Phase::Idle;
        self.emit_state(CoreState::Idle);
    }

    fn cancel(&mut self) {
        self.recorder = None;
        self.stream = None;
        self.finals.clear();
        self.partial = None;
        self.done_handled = false;
        self.phase = Phase::Idle;
        self.discard_audio();
        self.emit_state(CoreState::Idle);
    }

    fn shutdown(&mut self) {
        self.recorder = None;
        self.stream = None;
        self.engine = None;
    }

    fn poll_partial(&mut self) {
        if self.phase != Phase::Listening || self.last_partial_at.elapsed() < PARTIAL_INTERVAL {
            return;
        }
        self.last_partial_at = Instant::now();

        // A partial is a full decode of the pending audio. Once the pending
        // window is long, decoding it would starve the audio queue and drop
        // speech; wait for the engine's normal 25-35 s window instead.
        let pending = match self.stream.as_ref() {
            Some(stream) => stream.pending_seconds(),
            None => return,
        };
        if pending > PARTIAL_MAX_PENDING_SECONDS {
            return;
        }

        let result = match self.stream.as_mut() {
            Some(stream) => stream.partial(),
            None => return,
        };

        match result {
            Ok(Some(text)) => {
                let text = normalize_whitespace(&text);
                if !text.is_empty() && self.partial.as_deref() != Some(text.as_str()) {
                    self.emitter.emit(&Event::Partial { text: text.clone() });
                    self.partial = Some(text);
                }
            }
            Ok(None) => {}
            Err(err) => self.recover_engine(err),
        }
    }

    /// Feed every queued chunk to the active stream; `None` means it is drained.
    fn drain_audio(&mut self) -> Option<anyhow::Error> {
        loop {
            let chunk = match self.audio_rx.try_recv() {
                Ok(chunk) => chunk,
                Err(_) => return None,
            };

            let fed = match self.stream.as_mut() {
                Some(stream) => stream.feed(&chunk.samples),
                None => continue,
            };
            if let Err(err) = fed {
                return Some(err);
            }
        }
    }

    fn discard_audio(&mut self) {
        while self.audio_rx.try_recv().is_ok() {}
    }

    fn take_segments(&mut self) -> Vec<Segment> {
        let mut segments = Vec::new();
        if let Some(stream) = self.stream.as_mut() {
            while let Some(segment) = stream.next_segment() {
                segments.push(segment);
            }
        }
        segments
    }

    fn emit_segments(&mut self) {
        let segments = self.take_segments();
        for segment in segments {
            self.emitter.emit(&Event::Final {
                text: segment.text.clone(),
                start: segment.start,
                end: segment.end,
            });
            self.finals.push(segment);
        }
    }

    /// A decode failure is recoverable: close the stream but keep the engine.
    fn recover_engine(&mut self, err: anyhow::Error) {
        self.emitter
            .emit(&protocol::error(format!("{err:#}"), "engine"));
        self.recorder = None;
        self.stream = None;
        self.finals.clear();
        self.partial = None;
        self.done_handled = false;
        self.phase = Phase::Idle;
        self.discard_audio();
        self.emit_state(CoreState::Idle);
    }
}

fn session_loop(emitter: Emitter, cmd_rx: Receiver<protocol::Command>) {
    let (audio_tx, audio_rx) = mpsc::sync_channel::<audio::AudioChunk>(AUDIO_QUEUE);
    let mut session = Session::new(emitter, audio_tx, audio_rx);

    loop {
        if let Some(err) = session.drain_audio() {
            session.recover_engine(err);
        }
        session.emit_segments();

        match cmd_rx.recv_timeout(POLL_INTERVAL) {
            Ok(protocol::Command::Start) => session.start(),
            Ok(protocol::Command::Stop) => session.stop(),
            Ok(protocol::Command::Cancel) => session.cancel(),
            Ok(protocol::Command::Shutdown) => {
                session.shutdown();
                break;
            }
            Ok(protocol::Command::Ping { .. }) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                session.shutdown();
                break;
            }
        }

        session.poll_partial();
    }
}

// ---------------------------------------------------------------------------
// CLI modes
// ---------------------------------------------------------------------------

struct TranscribeArgs {
    wav: PathBuf,
    model_dir: Option<PathBuf>,
    json: bool,
}

fn transcribe_cmd(args: &[String]) -> Result<i32> {
    let parsed = match parse_transcribe_args(args) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(usage_error(&message)),
    };

    if let Some(dir) = &parsed.model_dir {
        std::env::set_var(ENV_MODEL_DIR, dir);
    }

    let mut progress = StderrProgress::new();
    let dir = model::ensure_model(&mut |update| progress.handle(update))
        .context("prepare the Phonon-2.5 model")?;
    let engine = Engine::open(&dir).context("load the Phonon-2.5 engine")?;

    let (samples, sample_rate) = read_wav_mono(&parsed.wav)?;
    if samples.is_empty() {
        bail!("{} contains no audio samples", parsed.wav.display());
    }

    let mut stream = engine
        .stream(sample_rate)
        .context("start the transcription stream")?;
    let mut finals: Vec<Segment> = Vec::new();

    for chunk in samples.chunks(TRANSCRIBE_CHUNK) {
        stream.feed(chunk).context("feed audio to the engine")?;
        drain_segments(&mut stream, &mut finals);
    }

    let partial = stream
        .partial()
        .context("read the provisional transcript")?;
    stream.finish().context("finish the transcription")?;
    drain_segments(&mut stream, &mut finals);

    let text = join_transcript(&finals, partial.as_deref());
    if parsed.json {
        let encoded = serde_json::to_string(&text).context("encode the transcript as JSON")?;
        println!("{{\"text\":{encoded}}}");
    } else {
        println!("{text}");
    }
    Ok(0)
}

fn parse_transcribe_args(args: &[String]) -> std::result::Result<TranscribeArgs, String> {
    let mut wav: Option<PathBuf> = None;
    let mut model_dir: Option<PathBuf> = None;
    let mut json = false;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => json = true,
            "--model-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--model-dir requires a directory".to_string())?;
                model_dir = Some(PathBuf::from(value));
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other}"));
            }
            other => {
                if wav.is_some() {
                    return Err(format!("unexpected argument {other}"));
                }
                wav = Some(PathBuf::from(other));
            }
        }
        index += 1;
    }

    let wav = wav.ok_or_else(|| "transcribe requires a WAV path".to_string())?;
    Ok(TranscribeArgs {
        wav,
        model_dir,
        json,
    })
}

fn models_cmd(args: &[String]) -> Result<i32> {
    let (action, model_dir) = match parse_models_args(args) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(usage_error(&message)),
    };

    if let Some(dir) = &model_dir {
        std::env::set_var(ENV_MODEL_DIR, dir);
    }

    match action.as_str() {
        "status" => {
            let dir = model::model_dir().context("resolve the model directory")?;
            let installed = model::is_installed(&dir);
            let bytes = std::fs::metadata(dir.join("weights.bin"))
                .map(|meta| meta.len())
                .unwrap_or(0);
            let dir_json = serde_json::to_string(&dir.display().to_string())
                .context("encode the model directory")?;
            println!("{{\"installed\":{installed},\"dir\":{dir_json},\"bytes\":{bytes}}}");
            Ok(0)
        }
        "install" => {
            let mut progress = StderrProgress::new();
            let dir = model::ensure_model(&mut |update| progress.handle(update))
                .context("install the Phonon-2.5 model")?;
            println!("{}", dir.display());
            Ok(0)
        }
        _ => Ok(usage_error("models expects status or install")),
    }
}

fn parse_models_args(args: &[String]) -> std::result::Result<(String, Option<PathBuf>), String> {
    let mut action: Option<String> = None;
    let mut model_dir: Option<PathBuf> = None;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--model-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--model-dir requires a directory".to_string())?;
                model_dir = Some(PathBuf::from(value));
            }
            "status" | "install" => {
                if action.is_some() {
                    return Err(format!("unexpected argument {}", args[index]));
                }
                action = Some(args[index].clone());
            }
            other => return Err(format!("unexpected argument {other}")),
        }
        index += 1;
    }

    let action = action.ok_or_else(|| "models requires status or install".to_string())?;
    Ok((action, model_dir))
}

fn devices_cmd() -> Result<()> {
    for name in audio::list_input_devices().context("list input devices")? {
        println!("{name}");
    }
    Ok(())
}

fn drain_segments(stream: &mut Stream, finals: &mut Vec<Segment>) {
    while let Some(segment) = stream.next_segment() {
        finals.push(segment);
    }
}

fn read_wav_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("open {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels == 0 {
        bail!("{} has no audio channels", path.display());
    }

    let interleaved: std::result::Result<Vec<f32>, hound::Error> =
        match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Float, _) => reader
                .samples::<f32>()
                .collect::<std::result::Result<Vec<f32>, _>>(),
            (hound::SampleFormat::Int, 8) => reader
                .samples::<i8>()
                .map(|sample| sample.map(|value| f32::from(value) / 128.0))
                .collect::<std::result::Result<Vec<f32>, _>>(),
            (hound::SampleFormat::Int, 16) => reader
                .samples::<i16>()
                .map(|sample| sample.map(|value| f32::from(value) / 32_768.0))
                .collect::<std::result::Result<Vec<f32>, _>>(),
            (hound::SampleFormat::Int, 24) => reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / 8_388_608.0))
                .collect::<std::result::Result<Vec<f32>, _>>(),
            (hound::SampleFormat::Int, 32) => reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / 2_147_483_648.0))
                .collect::<std::result::Result<Vec<f32>, _>>(),
            (hound::SampleFormat::Int, bits) => {
                bail!("unsupported sample width {bits} bits in {}", path.display())
            }
        };

    let interleaved =
        interleaved.with_context(|| format!("read samples from {}", path.display()))?;
    if interleaved.is_empty() {
        bail!("{} contains no audio samples", path.display());
    }

    let mono = audio::downmix_f32(&interleaved, usize::from(spec.channels));
    Ok((mono, spec.sample_rate))
}

/// Human-readable model progress for the one-shot CLI commands.
struct StderrProgress {
    last_percent: Option<u64>,
    last_bytes: u64,
    last_phase: Option<&'static str>,
}

impl StderrProgress {
    fn new() -> Self {
        StderrProgress {
            last_percent: None,
            last_bytes: 0,
            last_phase: None,
        }
    }

    fn handle(&mut self, update: ModelProgress) {
        match update {
            ModelProgress::Downloading { received, total } => {
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| received.saturating_mul(100) / total);
                let report = match percent {
                    Some(percent) => self
                        .last_percent
                        .is_none_or(|last| percent >= last.saturating_add(10) || percent == 100),
                    None => received.saturating_sub(self.last_bytes) >= 8 * 1024 * 1024,
                };
                if report {
                    self.last_percent = percent;
                    self.last_bytes = received;
                    match total {
                        Some(total) => {
                            eprintln!("downloading model: {received}/{total} bytes")
                        }
                        None => eprintln!("downloading model: {received} bytes"),
                    }
                }
            }
            ModelProgress::Extracting => {
                if self.last_phase != Some("extracting") {
                    self.last_phase = Some("extracting");
                    eprintln!("extracting model...");
                }
            }
            ModelProgress::Loading => {
                if self.last_phase != Some("loading") {
                    self.last_phase = Some("loading");
                    eprintln!("loading model...");
                }
            }
            ModelProgress::Ready => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Text and platform helpers
// ---------------------------------------------------------------------------

fn normalize_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join_transcript(segments: &[Segment], partial: Option<&str>) -> String {
    let joined = segments
        .iter()
        .map(|segment| normalize_whitespace(&segment.text))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if !joined.is_empty() {
        joined
    } else {
        partial.map(normalize_whitespace).unwrap_or_default()
    }
}

fn platform_key() -> String {
    platform_key_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn platform_key_for(os: &str, arch: &str) -> String {
    let os = match os {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match arch {
        "x86_64" | "x86" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str) -> Segment {
        Segment {
            text: text.to_string(),
            start: 0.0,
            end: 1.0,
        }
    }

    #[test]
    fn platform_key_maps_supported_targets() {
        assert_eq!(platform_key_for("windows", "x86_64"), "win32-x64");
        assert_eq!(platform_key_for("macos", "aarch64"), "darwin-arm64");
        assert_eq!(platform_key_for("macos", "x86_64"), "darwin-x64");
        assert_eq!(platform_key_for("linux", "x86_64"), "linux-x64");
        assert_eq!(platform_key_for("linux", "aarch64"), "linux-arm64");
    }

    #[test]
    fn platform_key_reports_this_build() {
        let key = platform_key();
        assert_eq!(
            key,
            platform_key_for(std::env::consts::OS, std::env::consts::ARCH)
        );
        assert_eq!(key.matches('-').count(), 1);
    }

    #[test]
    fn join_transcript_trims_and_joins_with_one_space() {
        let segments = [segment("  Hello "), segment("world.  ")];
        assert_eq!(join_transcript(&segments, None), "Hello world.");
    }

    #[test]
    fn join_transcript_falls_back_to_the_partial() {
        assert_eq!(join_transcript(&[], Some("  last words ")), "last words");
        assert_eq!(
            join_transcript(&[segment("   ")], Some("hello   there")),
            "hello there"
        );
        assert_eq!(join_transcript(&[], None), "");
    }
}

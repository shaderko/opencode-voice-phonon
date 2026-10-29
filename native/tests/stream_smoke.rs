//! Gated integration test for the streaming API.
//!
//! Run with a cached model and the repo test clip:
//!
//! ```text
//! OPENCODE_VOICE_MODEL_DIR=<dir> \
//! OPENCODE_VOICE_WAV=tests/data/4077-13754-0014.wav \
//! cargo test --manifest-path native/Cargo.toml --test stream_smoke -- --nocapture
//! ```
//!
//! Without `OPENCODE_VOICE_MODEL_DIR` the test returns immediately, so the
//! normal offline test run stays fast and model-free.

use std::path::Path;

use voice_core::engine::Engine;

fn read_mono(path: &Path) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path).expect("open test wav");
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let mut interleaved = Vec::new();
    match spec.sample_format {
        hound::SampleFormat::Float => {
            interleaved.extend(reader.samples::<f32>().map(|s| s.expect("sample")));
        }
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
            interleaved.extend(
                reader
                    .samples::<i32>()
                    .map(|s| s.expect("sample") as f32 * scale),
            );
        }
    }
    let samples = if channels <= 1 {
        interleaved
    } else {
        let frames = interleaved.len() / channels;
        let mut mono = Vec::with_capacity(frames);
        for frame in interleaved.chunks_exact(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
        mono
    };
    (samples, spec.sample_rate)
}

#[test]
fn partial_then_final() {
    let Some(model_dir) = std::env::var_os("OPENCODE_VOICE_MODEL_DIR") else {
        eprintln!("skipping: OPENCODE_VOICE_MODEL_DIR is not set");
        return;
    };
    let wav = std::env::var_os("OPENCODE_VOICE_WAV")
        .map(Into::into)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/data/4077-13754-0014.wav")
        });

    let (samples, rate) = read_mono(&wav);
    assert!(samples.len() > rate as usize / 2, "test clip is too short");

    let engine = Engine::open(Path::new(&model_dir)).expect("open engine");
    let mut stream = engine.stream(rate).expect("open stream");

    let mut partial_seen = String::new();
    let mut finals = Vec::new();

    for (index, chunk) in samples.chunks(1600).enumerate() {
        stream.feed(chunk).expect("feed");
        while let Some(segment) = stream.next_segment() {
            if !segment.text.trim().is_empty() {
                finals.push(segment.text);
            }
        }
        // A partial is a full decode of the pending audio, so probe a few
        // times rather than on every 100 ms chunk.
        if partial_seen.is_empty() && matches!(index, 20 | 50 | 90) {
            if let Some(partial) = stream.partial().expect("partial") {
                if !partial.trim().is_empty() {
                    partial_seen = partial;
                }
            }
        }
    }

    stream.finish().expect("finish");
    while let Some(segment) = stream.next_segment() {
        if !segment.text.trim().is_empty() {
            finals.push(segment.text);
        }
    }

    let text = finals.join(" ").trim().to_string();
    println!("partial: {partial_seen}");
    println!("final:   {text}");

    assert!(
        !partial_seen.is_empty(),
        "expected a non-empty provisional transcript before finish"
    );
    assert!(!text.is_empty(), "expected a non-empty final transcript");
    assert!(
        text.to_lowercase().contains("unconstitutionality"),
        "unexpected transcript: {text}"
    );
}

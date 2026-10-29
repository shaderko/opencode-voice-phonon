# Architecture

`opencode-voice-phonon` is an OpenCode V2 plugin in three parts:

1. **Desktop GUI** — a `ComposerPill` above the session composer, a command,
   and an Ipc bridge from the Electron main process to the Rust sidecar. The
   final transcript is inserted into the composer with `screen.composer.insert`.
2. **TypeScript TUI plugin** — a Solid component in the `prompt.footer` slot, a
   keybind/slash/palette command, UI state, and the child-process client.
3. **`voice-core` Rust sidecar** — microphone capture, model download and
   cache management, the Phonon-2.5 engine, and the JSONL protocol.

The wire contract between them is [`protocol.md`](protocol.md). That file is
the source of truth for commands, events and ordering; this document explains
how the implementation satisfies it.

## Components

| Path | Role |
| --- | --- |
| `src/index.ts` | Server-side plugin entry (`Plugin.define({ id: "voice.phonon" })`). Intentionally empty in 0.1.0; the TUI and GUI parts own their lifecycles. |
| `src/gui.tsx` | Desktop GUI entry (`./gui-experimental`). Window setup registers the composer pill and command; main setup owns one `VoiceBackend` and provides the `VoiceIpc` bridge. |
| `src/gui-contract.ts` | Effect-schema `Ipc` contract (`voice.phonon.voice`) for start/stop/cancel/status and state/partial/done/error events. |
| `dist/gui-experimental.cjs` | Prebuilt CommonJS GUI bundle produced by `vite build` with `@opencode/plugin/gui/vite`. |
| `src/tui.tsx` | TUI entry (`voice.phonon.tui`). Renders the footer mic, registers `voice.phonon.toggle`, owns one `VoiceBackend`, submits prompts. |
| `src/backend.ts` | Spawns `voice-core stream`, writes JSONL commands, parses stdout lines, keeps a 40-line stderr ring, disposes with a 1.5 s grace period. |
| `src/state.ts` | Pure reducer: `VoiceState`, `reduceVoice`, `transcript`. No framework or process imports. |
| `src/config.ts` | Normalizes plugin options; never throws. |
| `src/protocol.ts` | TypeScript mirror of the v1 protocol and its parser. |
| `src/platform.ts` | Platform key, packaged binary path, and resolution order for the executable. |
| `native/src/main.rs` | CLI (`stream`, `transcribe`, `models`, `devices`) and the session loop. |
| `native/src/audio.rs` | `cpal` default input device, downmix to mono `f32`, bounded channel. |
| `native/src/model.rs` | Cache roots, download, SHA-256 verification, safe extraction, atomic install. |
| `native/src/engine.rs` | Safe Rust wrapper over the C engine (`p25_*`), `Engine`, `Stream`, `Segment`. |
| `native/src/protocol.rs` | Rust mirror of the v1 protocol. |
| `native/build.rs` | Compiles the vendored C sources into the binary. |
| `native/vendor/phonon25/` | MIT `phonon-2.5-c` engine plus a small Windows compatibility layer. |

## Data flow

A recording, end to end:

```
Desktop window                 Electron main                  voice-core
  ComposerPill / Command --Ipc-->  VoiceBackend  --JSONL-->  capture, model cache,
  composer.insert()      <--Ipc--  one per app              lifecycle, CLI
                                                                   │
TUI window (Solid)                                                 ▼
  footer + keybind      --JSONL-->  VoiceBackend  ────────►  Phonon-2.5 (C)
  review / submit       <--JSONL--  one per TUI               (vendored kernels)
```

`done.text` is the authoritative transcript: the sidecar joins every `final`
with single spaces, falling back to the last partial when no window closed.
`partial` events are advisory and replace each other.

## Threading

`voice-core stream` uses three kinds of threads:

| Thread | Owns | Behaviour |
| --- | --- | --- |
| Main | stdin `BufReader`, stdout emitter | Reads one JSON command per line. Answers `ping` inline with `pong`. Forwards everything else over an `mpsc` channel; a `shutdown` or EOF ends the loop and joins the session. |
| Session | `Engine`, `Stream`, `Recorder`, `finals`, `partial`, phase | Loops on `recv_timeout(50 ms)`. Each pass drains queued audio into the stream, emits any completed segments, handles one command, then polls the partial timer. |
| cpal callback | Device stream | Converts samples to `f32`, downmixes to mono, and `try_send`s into a `sync_channel(2048)`. It never blocks: if the consumer is behind, the chunk is dropped. |

The stdout emitter is a `Mutex<BufWriter<Stdout>>` shared by the main and
session threads, so events are written one complete line at a time and flushed.

Capabilities are encoded in the Rust types: `Stream` is `!Send` (one thread at
a time), while `Engine` is `Send + Sync` because the C engine's model is
immutable after `p25_engine_open`. A `Stream` holds an `Arc` to its engine, so
closing the engine handle cannot invalidate a live stream.

The TUI is single-threaded from the plugin's point of view: backend events
arrive on Node's event loop and are folded synchronously into the Solid signal.
Desktop has two processes: the window renders Solid state from Ipc events, and
the Electron main process owns the single `VoiceBackend` and forwards commands.
The Ipc is scoped to `voice.phonon.voice`, under the plugin id, and carries
only status, partial, done and error events.

## Streaming semantics

Phonon-2.5 is a full-context model. It does not emit a word as soon as it is
spoken.

- Audio is fed continuously; the engine cuts a window when it has enough
  context, typically after 25–35 s of speech.
- Completed windows become `final` events. During a long recording, finals can
  arrive before `stop`.
- `stream.partial()` decodes the pending audio and returns provisional text.
  The session polls it every **700 ms** while `listening`, normalizes
  whitespace, and emits only when the text changed. Once more than **10 s** is
  pending, it waits for the engine's normal window instead: a long partial
  decode would starve the audio queue.
- The footer shows at most 48 characters of the partial, with an ellipsis.
- On `stop`, capture is dropped first so no new audio can arrive, then the
  queue is drained, remaining finals are emitted, the tail is decoded with
  `finish()`, and one `done` is emitted.
- `cancel` drops the recorder and stream, clears queued audio, emits
  `state(idle)`, and emits no `final` or `done`.

There is no resampling in the Rust layer: the engine stream is opened at the
microphone's native sample rate and the C engine handles its own input
resampling. `transcribe` accepts any WAV sample rate the same way.

## Model lifecycle

The model is resolved lazily on the first `start` (or the first `transcribe` /
`models install`), never at process startup. `hello` is printed immediately.

1. `model::is_installed(dir)` checks that `weights.bin` is a non-empty file and
   `weights.json` / `tokens.txt` exist.
2. If not installed, `download()` streams the archive into
   `<cache>/.phonon-2.5-<pid>-<nanos>.tar.gz.part`, hashing with SHA-256 as it
   writes and reporting `model(downloading)` progress.
3. The hash **and** exact byte count (`183,463,606`) are checked before
   extraction. A mismatch aborts with `model_checksum`.
4. `extract_archive()` unpacks into a sibling staging directory, rejecting
   absolute paths, drive/UNC prefixes and any `..` component. Only regular
   files and directories are extracted; links and special files are dropped.
5. `locate_weights_dir()` looks for `c_weights/`, then the root, then up to
   four directory levels deep for a directory with all three files.
6. The staged directory is renamed into place (copy + delete across volumes).
   Temporary paths are removed on drop, so a failed install leaves no partial
   tree that could be mistaken for a valid model.
7. `Engine::open()` maps the weights and reports `model(loading)` then
   `model(ready)`.

The engine stays loaded across recordings and is released only on `shutdown`
or process exit. A decode error closes the stream but keeps the engine, so the
next `start` does not pay the load cost again. `model(ready)` is informational;
`state(listening)` is what moves the UI forward.

The download cannot be cancelled mid-flight in 0.1.0: there is no protocol
command for it, and closing the process is the only abort.

## Packaging

The TypeScript TUI source is shipped directly (no build step for consumers),
and the GUI ships as one prebuilt CommonJS file:

```json
"exports": {
  ".": "./src/index.ts",
  "./tui": "./src/tui.tsx",
  "./gui-experimental": "./dist/gui-experimental.cjs"
}
```

`npm run build:gui` (also run by `prepack`) uses the
`@opencode/plugin/gui/vite` preset to compile `src/gui.tsx` into
`dist/gui-experimental.cjs`, keeping `@opencode/plugin/gui`, Solid, Effect and
Node/Electron built-ins external. Desktop loads that file from the package.

Native binaries live at `bin/<platform>-<arch>/voice-core[.exe]` and are
selected by `src/platform.ts`.

Resolution order for the executable:

1. `OPENCODE_VOICE_BIN` — explicit absolute/relative path; must exist.
2. `OPENCODE_VOICE_DEV=1` — `native/target/release/voice-core[.exe]`.
3. Packaged — `bin/<platform>-<arch>/voice-core[.exe]`.

If the key is unsupported or the file is missing, startup fails with an error
naming the supported platforms; the TUI shows it as a toast rather than
throwing into OpenCode.

| Platform key | Runner (CI) | Rust target | Notes |
| --- | --- | --- | --- |
| `win32-x64` | `windows-latest` | `x86_64-pc-windows-msvc` | MSVC flags `/arch:AVX2`, `/fp:fast`; C11 atomics. |
| `darwin-arm64` | `macos-14` | `aarch64-apple-darwin` | `-mcpu=apple-m1`. |
| `darwin-x64` | `macos-13` | `x86_64-apple-darwin` | `-mavx2 -mfma`. |
| `linux-x64` | `ubuntu-latest` | `x86_64-unknown-linux-gnu` | ALSA headers at build time, ALSA runtime. |
| `linux-arm64` | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | Same. |

The release binary is ~2.7 MB; the npm tarball with a single platform was
1.4 MB compressed. `ci.yml` builds and packages all five targets on every push
and pull request. `release.yml` repackages the same five on a `v*` tag, then
publishes only after `node scripts/check-binaries.mjs --require-all` passes.

## Design trade-offs

**Composer insert differs by surface.** The Desktop GUI has a public
`screen.composer.insert(text)` API, so the transcript lands in the draft at the
cursor and the user sends it. The TUI has no public composer-insert API, so it
submits via `session.prompt`; the review dialog (`review: true`, the default)
is its editing step. The GUI always uses the draft and never sends on the
user's behalf.

**C inference instead of pure Rust.** Fermion provides no Rust or ONNX runtime
for the 25-language Phonon-2.5 model. Reimplementing the encoder/decoder would
be a research project and would risk diverging from the reference outputs. The
plugin vendors the MIT C engine verbatim and wraps it in a small, audited FFI
layer. The trade-off is a C toolchain at build time and `unsafe` FFI at the
boundary; the upside is numerical fidelity and a much smaller scope.

The C engine is CPU-only. Fermion's GPU paths are MLX on Apple silicon and CUDA
through its Python/torch engine or CUDA container; neither is a drop-in for the
Rust/C sidecar. A GPU backend would need a separate Python/CUDA runtime or an
ONNX/ONNX Runtime port, both larger than the “no additional installs” target.
0.1.0 uses four CPU workers by default (`P25_THREADS` overrides).

**Download instead of bundling weights.** Bundling 183 MB (255 MB unpacked)
would inflate every install, including for users who never record. Downloading
once with a pinned checksum keeps the package small. The cost is a slow first
use and a network dependency on Hugging Face for that first run.

**Full-context windows instead of true streaming.** Partials give immediate
feedback but are provisional, and final text arrives in 25–35 s windows. This
matches the model rather than pretending otherwise.

**Per-platform binaries instead of WASM.** WASM would remove the platform
matrix but would give up AVX2/NEON kernels, native threads and `cpal` device
access, and would be far slower.

**One recording per sidecar.** A second `start` returns `busy`. Desktop's
Electron main process owns one sidecar for the app; each TUI process owns its
own. This keeps one engine, one stream and one microphone stream, and makes the
protocol simple. Concurrent dictation would need a second sidecar and a second
ui affordance.

## Failure modes

| Failure | Sidecar behaviour | Plugin behaviour |
| --- | --- | --- |
| `start` while recording | `error(busy)` | Toast; existing recording continues. |
| No input device / open failure | `error(no_input)` then `state(idle)` | Toast; state reset; next start retries. |
| OS denies microphone | `error(permission)` then `state(idle)` | Toast; user fixes OS permission. |
| Download HTTP/TLS failure | `error(model_download)` then `state(idle)` | Toast with detail; retry downloads again. |
| Checksum or byte-count mismatch | `error(model_checksum)` then `state(idle)` | Toast; `.part` removed; retry. |
| Bad archive / missing files | `error(model_unpack)` then `state(idle)` | Toast; staging removed. |
| Engine rejects weights | `error(model_load)` then `state(idle)` | Toast; cache must be repaired. |
| Decode/stream call fails | `error(engine)`; stream closed, engine kept | Toast; state reset; next start reuses the engine. |
| Malformed command | `error(protocol)`; process continues | Not normally reachable from the plugin. |
| `fatal` | Process exits | Backend emits `exit`; toast with code/signal; a new sidecar spawns on the next start. |
| Sidecar exits unexpectedly | — | `exit` event with the stderr tail; toast; state reset. |
| Spawn fails (missing binary, unsupported platform) | — | `spawn_error` toast naming the path and supported keys. |

The backend tolerates a child that dies mid-write: stdin/stdout/stderr `error`
handlers are installed, `send()` returns `false` instead of throwing, and
`dispose()` sends `shutdown`, waits 1.5 s, then kills.

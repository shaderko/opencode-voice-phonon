# voice-core protocol (v1)

`voice-core` is a long-lived child process spawned by the OpenCode TUI plugin.
It owns the microphone, the Phonon-2.5 engine, and the model cache. The plugin
never touches audio or model files itself.

## Transport

- **Commands** are JSON objects, one per line, written to `voice-core` stdin.
- **Events** are JSON objects, one per line, written to `voice-core` stdout.
- **Diagnostics** go to stderr. They are never parsed as events.
- UTF-8, LF line endings. One recording at a time per process.
- Every object carries `"v": 1`. A receiver must reject an unknown version
  with an `error` event (`code: "protocol_mismatch"`).

The process is spawned as:

```
voice-core stream
```

It prints `hello` immediately, then waits for commands. It does not open the
microphone or load the model until the first `start`.

## Commands

| Command | Meaning |
| --- | --- |
| `{"v":1,"type":"start"}` | Prepare the model if needed, then open the microphone and begin a recording. |
| `{"v":1,"type":"stop"}` | Stop capturing, finalize the pending audio, emit `final` events followed by `done`. |
| `{"v":1,"type":"cancel"}` | Stop capturing and discard the recording. No `final` or `done`. |
| `{"v":1,"type":"shutdown"}` | Release the microphone and model, then exit 0. |
| `{"v":1,"type":"ping","id":N}` | Reply with `pong` carrying the same id. |

`start` while a recording is active is an error (`code: "busy"`), not a
restart. `stop` or `cancel` while idle is a no-op. `stop` is idempotent: the
second `stop` does nothing.

## Events

| Event | Meaning |
| --- | --- |
| `{"v":1,"type":"hello","version":"0.1.0","model":"phonon-2.5","platform":"win32-x64"}` | Printed once at startup. |
| `{"v":1,"type":"state","state":"idle"}` | No recording. Also emitted after `done`, `cancel`, and recoverable errors. |
| `{"v":1,"type":"state","state":"preparing"}` | Model download/load or microphone open in progress. |
| `{"v":1,"type":"state","state":"listening"}` | The microphone is open and audio is being captured. |
| `{"v":1,"type":"state","state":"transcribing"}` | Capture stopped; the final window is being decoded. |
| `{"v":1,"type":"model","state":"downloading","received":123,"total":183463606}` | Model download progress. `total` may be absent. |
| `{"v":1,"type":"model","state":"extracting"}` | Download verified; unpacking weights. |
| `{"v":1,"type":"model","state":"loading"}` | Mapping weights and starting the engine. |
| `{"v":1,"type":"model","state":"ready"}` | Engine ready. |
| `{"v":1,"type":"partial","text":"hello wor"}` | Provisional transcript of pending audio. Replaces the previous partial. Advisory. |
| `{"v":1,"type":"final","text":"Hello world.","start":0.0,"end":1.84}` | One finished Phonon window. |
| `{"v":1,"type":"done","text":"Hello world."}` | Recording complete. `text` joins all `final` texts. |
| `{"v":1,"type":"error","message":"...","code":"..."}` | Recoverable or fatal error. The process stays alive unless the code is `fatal`. |
| `{"v":1,"type":"pong","id":N}` | Reply to `ping`. |

### Event ordering

A successful recording is:

```
state(preparing) [model(...)] state(listening)
partial(...)*
state(transcribing)
final(...)*
done(text)
state(idle)
```

- `final` events only occur after `stop` or when a 25–35 s window completes
  during a long recording. They never occur before `listening`.
- `done` is emitted exactly once per `stop`, after every `final`.
- `cancel` emits `state(idle)` and no `final`/`done`.
- A recoverable error emits `error` then `state(idle)`. The next `start` is
  allowed.

## Error codes

| Code | Meaning |
| --- | --- |
| `busy` | `start` while already recording. |
| `no_input` | No default microphone, or the device could not be opened. |
| `permission` | The OS denied microphone access. |
| `model_download` | Download failed; includes the HTTP/status detail. |
| `model_checksum` | The downloaded archive did not match the pinned SHA-256. |
| `model_unpack` | The archive was malformed or did not contain the expected files. |
| `model_load` | The C engine rejected the weights. |
| `engine` | A decode or stream call failed. |
| `protocol` | Malformed command. |
| `fatal` | The process cannot continue; the plugin should restart it. |

## Model

- Model: `phonon-2.5` (25 languages), C-engine repack `phonon-2.5-c-weights-v1`.
- Archive: `phonon-2.5-c-weights-v1.tar.gz`, 183,463,606 bytes,
  SHA-256 `ed622ca97bc4ec044c7ba5fb69c10985b1b3897e600dbf611840d9a0692b4cfe`.
- Source: `https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz`.
- The archive unpacks to `c_weights/{weights.bin,weights.json,tokens.txt}`.
  `voice-core` verifies the archive hash before extracting, and extracts only
  regular files under the destination directory.
- Cache location (override with `OPENCODE_VOICE_MODEL_DIR`):
  - Windows: `%LOCALAPPDATA%\opencode-voice-phonon\models\phonon-2.5-c-weights-v1`
  - macOS: `~/Library/Caches/opencode-voice-phonon/models/phonon-2.5-c-weights-v1`
  - Linux: `$XDG_CACHE_HOME/opencode-voice-phonon/models/phonon-2.5-c-weights-v1`
    (default `~/.cache/opencode-voice-phonon/models/phonon-2.5-c-weights-v1`)

Audio is processed in memory and never written to disk or sent over the
network. The only network request is the one-time model download.

# Security

This document describes what `opencode-voice-phonon` trusts, what it does with audio
and text, and what an attacker could and could not do. It is scoped to the
plugin and its sidecar, not to OpenCode, the model provider, or the operating
system.

## Threat model

### Assets

| Asset | Where it lives |
| --- | --- |
| Microphone audio | Process memory only, for the duration of a recording. |
| Transcript | TUI state, then the OpenCode session via `session.prompt`. |
| Model weights | A user-writable cache directory. |
| Credentials | None. The plugin has no accounts, tokens or API keys. |

### Trust boundaries

1. **OpenCode TUI ↔ `voice-core`.** A pipe carrying JSONL. The plugin is the
   only writer of stdin; the sidecar is the only writer of stdout. Neither side
   executes text from the other.
2. **`voice-core` ↔ operating system.** Microphone access is mediated by the
   OS permission model.
3. **`voice-core` ↔ Hugging Face.** One HTTPS GET, first run only.
4. **OpenCode ↔ model provider.** Outside this plugin's boundary, but reached
   by the prompt the plugin submits.

### Adversaries considered

- A network attacker or proxy tampering with the model download.
- A malicious or corrupted model archive.
- Malicious input on the sidecar's stdin (another local process writing to the
  pipe).
- Accidental capture of sensitive speech or background audio.
- Supply-chain compromise of the npm package or a prebuilt binary.

A local attacker who can already run code as the user, replace files in the
package, or read process memory is outside the mitigation scope. The sidecar
runs with the user's privileges and is not sandboxed.

## Network surface

The plugin makes exactly one kind of request: an HTTPS GET for the model
archive.

```
https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz
```

- TLS is provided by `ureq`'s rustls backend with the webpki-roots trust
  store.
- The request carries a fixed `User-Agent` (`opencode-voice-phonon/0.1.0`). No device
  identifiers, paths, audio or transcripts are included.
- There is no telemetry, analytics, crash reporting, update check or license
  check.
- After the model is cached, the plugin works offline. `voice-core transcribe`
  and `stream` make no network calls when the model is present.
- The hostname and URL are compile-time constants in `native/src/model.rs`;
  neither the plugin options nor the protocol can change them.

Residual risk: the first download depends on Hugging Face and on the local TLS
trust store. A TLS-intercepting proxy is trusted by design. The checksum below
is the defense against a tampered or corrupted payload.

## Download integrity and extraction

- The pinned archive is 183,463,606 bytes with SHA-256
  `ed622ca97bc4ec044c7ba5fb69c10985b1b3897e600dbf611840d9a0692b4cfe`.
- The hash is computed **while** the bytes are written to a `.part` file, then
  compared, together with the exact byte count, **before** any extraction
  starts. A mismatch returns `model_checksum` and nothing is unpacked.
- Extraction happens into a staging directory under the cache root. Each tar
  entry path is rejected if it is absolute, carries a Windows drive or UNC
  prefix, contains a NUL, or contains a `..` component. The extractor also
  checks `unpack_in`'s return value, so an entry that escapes is an error.
- Only regular files and directories are extracted. Symlinks, hard links,
  devices and other entry types are silently dropped — the model is three
  regular files and links are never followed.
- The verified directory is moved into place with a rename, falling back to a
  copy across volumes. The copy skips links and special files.
- Temporary archive and staging paths are removed on drop. A failed or
  interrupted install cannot be mistaken for a complete model: the installed
  check requires all three files and a non-empty `weights.bin`.

The archive is trusted once its hash matches. The hash is pinned in the source,
so changing the model requires a code change and a release.

## Child process handling

- The sidecar is spawned with `spawn(binary, ["stream"])` - no shell, no
  interpolation, no `exec`. Arguments are a constant array. In Desktop, the
  Electron main process owns the sidecar and exposes it to windows through the
  `voice.phonon.voice` Ipc; in the TUI, each TUI process owns one.
- `stdio` is three pipes. `windowsHide: true` avoids a console window.
- The executable is resolved in a fixed order: `OPENCODE_VOICE_BIN` (an
  explicit user choice), the development build under `OPENCODE_VOICE_DEV=1`,
  or `bin/<platform>-<arch>/voice-core[.exe]` inside the package. Missing or
  unsupported paths fail with an error instead of falling back to `PATH`.
- The sidecar inherits the environment, plus `OPENCODE_VOICE_MODEL_DIR` when
  the `modelDir` option is set. No secrets are added.
- Commands are fixed protocol objects; the plugin never forwards transcript
  text or user input as a command. The transcript only travels through
  `session.prompt`, after the sidecar has exited the recording path.
- stdout is parsed line by line. Unknown types, malformed JSON, wrong field
  types and version mismatches are rejected; a mismatch becomes a
  `protocol_mismatch` error event rather than being acted on.
- stderr is kept in a 40-line ring for diagnostics and optionally echoed when
  `OPENCODE_VOICE_DEBUG=1`. It is never parsed as protocol.
- On dispose, the plugin sends `shutdown`, waits 1.5 s, then kills the process.
  It drops all listeners so a late exit cannot report after disposal.

Residual risk: `OPENCODE_VOICE_BIN` intentionally executes a user-specified
binary. That is an explicit local trust decision, equivalent to running that
binary yourself.

## Audio handling

- Audio is captured by `cpal` from the default input device, converted to mono
  `f32`, and passed over a bounded channel (2048 chunks). If the consumer falls
  behind, the chunk is dropped rather than blocking the audio callback.
- Samples live in memory and are fed to the engine. They are never written to a
  temporary WAV, a log, the clipboard, or the cache directory.
- Dropping the recorder closes the device stream. `cancel` and process exit
  discard queued audio; the next `start` also drains leftovers so a cancelled
  recording cannot leak into the next one.
- Only the resulting text leaves the process. There is no audio upload path.
- As with any process memory, the OS may page it to swap or include it in a
  hibernation image. Disk encryption and OS swap settings are the user's
  controls; the plugin does not add a mitigation.

## Where the text goes

- **Desktop:** the transcript is inserted with
  `screen.composer.insert(text)` into the routed session's draft. The plugin
  does not send it; the user reviews and sends. Nothing leaves the machine.
- **TUI:** the transcript is submitted with
  `context.client.session.prompt({ sessionID, text })` to the **local**
  OpenCode server. The plugin itself sends it nowhere else.
- The TUI target is the session that was active when recording started, even if
  the user navigated away. The Desktop target is the composer captured at
  start, so switching sessions cannot retarget an in-flight recording.
- With `review: true` (TUI default), an editable dialog shows the transcript
  before submission; cancelling sends nothing.
- With `review: false`, the TUI transcript is sent on stop with no confirmation.
  This is a deliberate convenience trade-off: background speech, a TV, or a
  misheard phrase can become a prompt. Prefer `review: true` in shared spaces.
  Desktop always uses the composer as its review step.
- Once submitted, the text is an ordinary user prompt. It is stored in the
  session history and may be sent to the model provider configured for that
  session. The plugin does not control, log, or redact that downstream handling.
- Speech is untrusted input. A transcript can contain instructions spoken by
  someone else or played over speakers ("prompt injection by audio"). The
  Desktop composer and TUI review dialog are the mitigation; review the text
  before sending in environments where that matters.

## Data at rest and logging

- Model weights are cached under the per-user cache directory and are read-only
  inputs to the engine. They contain no user data.
- No recordings, partials, or transcripts are persisted by the plugin. Session
  history is managed by OpenCode.
- Debug output is stderr only and contains operational messages (paths, HTTP
  status, engine errors), not audio or transcript text.
- `voice-core models status` prints the resolved directory and installed size,
  which may reveal a username in a home-directory path. That is local terminal
  output only.

## Supply chain

- The npm package ships TypeScript source and prebuilt binaries. There is no
  postinstall script and no native build at install time.
- `scripts/check-binaries.mjs --require-all` gates publishing on all five
  platform binaries being present and larger than 1 MiB.
- The Windows executable is **unsigned** in 0.1.0, so SmartScreen may warn and
  there is no OS-level publisher verification. There is no reproducible-build
  attestation or Sigstore signature yet; both are future work.
- The Windows release links the MSVC C runtime statically. A clean machine does
  not need the Visual C++ Redistributable; the binary imports only Windows
  system DLLs.
- The Rust dependency set is small (`anyhow`, `serde`, `serde_json`, `cpal`,
  `ureq`, `sha2`, `flate2`, `tar`, `hound`, `ctrlc`); the C engine is vendored
  from the MIT `phonon-2.5-c` project. Cargo/npm lockfiles pin resolved
  versions.
- If you need stronger assurance, build from source with
  `npm run build:native` and point `OPENCODE_VOICE_BIN` at the result, or
  compare the packaged binary hash with the one built on the same target.

## Licenses and attribution

| Component | License | Notes |
| --- | --- | --- |
| `opencode-voice-phonon` plugin and Rust glue | MIT | This repository. |
| Vendored `phonon-2.5-c` engine | MIT | `native/vendor/phonon25/LICENSE`. The Windows compatibility layer is part of this package, also MIT. |
| Phonon-2.5 weights | CC-BY-4.0 | Fermion Research; downloaded by the user, not bundled. |
| NVIDIA `parakeet-tdt-0.6b-v3` | CC-BY-4.0 | Upstream model the weights are derived from. |
| Test audio `4077-13754-0014.wav` | CC BY 4.0 | From the upstream project; used only by the e2e test. |

CC-BY-4.0 requires attribution when the weights are redistributed. `NOTICE`
contains the attribution and source links. If you mirror the model cache or
republish the weights, keep that attribution and the list of changes intact.
The plugin's own MIT license does not relicense the weights.

## Reporting a vulnerability

Do not open a public issue for an exploitable problem. Report privately through
the project repository's GitHub security advisory feature, including:

- the plugin version (`package.json`), platform key and OpenCode version;
- a minimal reproduction or the exact command sequence;
- relevant stderr with `OPENCODE_VOICE_DEBUG=1` (remove usernames and paths you
  do not want to share);
- whether the issue affects audio confidentiality, prompt submission, model
  installation, or the child-process boundary.

You should receive an acknowledgement and a coordinated disclosure timeline.
There is no bug bounty.

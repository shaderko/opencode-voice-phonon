# Troubleshooting

Each section is **symptom → cause → fix**. Start with the three quick checks:

```bash
# packaged binary; it is not put on PATH
"<package>/bin/<platform>-<arch>/voice-core[.exe]" --version
"<package>/bin/<platform>-<arch>/voice-core[.exe]" devices
"<package>/bin/<platform>-<arch>/voice-core[.exe]" models status
```

and run OpenCode with sidecar diagnostics enabled:

```bash
# macOS / Linux / Git Bash
OPENCODE_VOICE_DEBUG=1 opencode

# Windows PowerShell
$env:OPENCODE_VOICE_DEBUG = "1"
opencode
```

The sidecar writes diagnostics to stderr; the TUI only keeps the last 40 lines
for its exit toast, so the flag is the reliable way to see them.

## The microphone does not appear in the prompt footer

**Cause:** the footer slot only renders inside a session (`sessionID` is
required), the config was not picked up, or the platform is unsupported.

**Fix:**

- Open a session first. On the session list the mic is intentionally hidden.
- Check that `opencode.json(c)` has the plugin under `plugins` (see
  `examples/opencode.jsonc`), then restart OpenCode.
- Confirm the platform:

  ```bash
  node -p "process.platform + '-' + process.arch"
  ```

  Supported: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`.
- If the binary is missing, startup shows a toast such as `voice-core is not
  packaged for linux-arm64` or `Unsupported platform`. Reinstall the package,
  or build locally and set `OPENCODE_VOICE_DEV=1`.

## The Voice pill does not appear in Desktop

**Cause:** Desktop reads GUI plugins only from the **global**
`opencode.json(c)`, the package has no built `dist/gui-experimental.cjs`, the
plugin is disabled under **Settings > Extensions > Plugins**, or the server part
failed to load. A plugin listed only in `cli.json` can load the TUI but not the
Desktop GUI.

**Fix:**

- Put the plugin in the global `opencode.json(c)` (not only `cli.json`) and
  reload Desktop.
- Confirm `node_modules/opencode-voice-phonon/dist/gui-experimental.cjs` exists. From
  the repo run `npm run build:gui`; installing from npm should include it
  because `prepack` builds it.
- Open **Settings > Extensions > Plugins** and check that `voice.phonon` is
  loaded and enabled.
- Check the Desktop/server log for a GUI or server-part load error. A plugin
  whose server part fails has no GUI.
- The plugin id must not collide with an OpenCode built-in id or a nested id.
  `voice.phonon` is the intended id.
- In Desktop, the pill appears above a session's composer; there is no footer
  mic. In the TUI, the mic appears in the prompt footer instead.

## The keybind does nothing

**Cause:** another command owns `Ctrl+Space`, the terminal/IME intercepts it,
or the configured value is invalid.

**Fix:**

- IMEs on Windows and some CJK input methods use `Ctrl+Space` to switch input
  mode. Try `/voice` from the prompt or **Voice: Dictate prompt** in the command
  palette; the command id is `voice.phonon.toggle`.
- Change the option to a combination your terminal passes through, for example:

  ```jsonc
  { "keybind": "ctrl+alt+space" }
  ```

  Values containing whitespace are rejected and fall back to `ctrl+space`.
- Restart OpenCode after editing the config.

## "Open a session first" or "No active session to submit to"

**Cause:** recording was started outside a session, or the start happened
before a session was active.

**Fix:** open a conversation and start dictation there. The plugin captures the
session that was active at **start**; navigating to another session while
recording still submits to the original one.

## "No default input device" / `no_input`

**Cause:** the OS has no default recording device, or the device cannot be
opened (unplugged, exclusive use, disabled).

**Fix:**

```bash
voice-core devices
```

If the list is empty, enable a microphone in the OS sound settings and set it
as the default input. Unplug/replug USB devices, close applications that hold
the device exclusively, then restart the recording. The next `start` retries;
the sidecar stays alive.

## Microphone permission denied (`permission`)

**Cause:** the OS blocked microphone access for the terminal (or the app that
launched OpenCode).

**Fix:**

- **macOS:** System Settings → Privacy & Security → Microphone → enable the
  terminal app (Terminal, iTerm, VS Code, …). Quit and reopen the terminal;
  macOS does not apply the change to a running process.
- **Windows:** Settings → Privacy & security → Microphone → **Let desktop apps
  access your microphone**.
- **Linux:** check that the user is in the `audio` group where applicable, and
  that PulseAudio/PipeWire is running.

The error clears the recording; start again after granting access.

## Model download fails (`model_download`)

**Cause:** no network, a proxy/firewall blocking Hugging Face, TLS
interception, or the host returning a non-200 status.

**Fix:**

- Test the URL in a browser or with `curl`:

  ```bash
  curl -I -L https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz
  ```

- Configure your proxy for the OpenCode process. The sidecar inherits its
  environment, so `HTTPS_PROXY` / `HTTP_PROXY` apply.
- Install manually and point the plugin at the unpacked directory. The archive
  must match the pinned size and hash:

  ```bash
  curl -fL --retry 3 -o phonon-2.5-c-weights-v1.tar.gz \
    https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz
  sha256sum phonon-2.5-c-weights-v1.tar.gz     # Linux
  shasum -a 256 phonon-2.5-c-weights-v1.tar.gz # macOS
  ```

  Expected SHA-256:
  `ed622ca97bc4ec044c7ba5fb69c10985b1b3897e600dbf611840d9a0692b4cfe`
  (183,463,606 bytes).

  Windows PowerShell:

  ```powershell
  Invoke-WebRequest -Uri "https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz" -OutFile "phonon-2.5-c-weights-v1.tar.gz"
  Get-FileHash .\phonon-2.5-c-weights-v1.tar.gz -Algorithm SHA256
  ```

  Then unpack and point at the directory that contains the three files:

  ```bash
  tar -xzf phonon-2.5-c-weights-v1.tar.gz -C /path/to/model
  # files land in /path/to/model/c_weights/{weights.bin,weights.json,tokens.txt}
  ```

  Set the plugin option `"modelDir": "/path/to/model/c_weights"`, or the
  environment variable `OPENCODE_VOICE_MODEL_DIR`.

## Checksum mismatch (`model_checksum`)

**Cause:** the download was interrupted, corrupted by a proxy, or is not the
pinned archive.

**Fix:** remove leftovers and retry. The `.part` file lives in the cache root,
next to the model directory:

```powershell
# Windows
Remove-Item -Force "$env:LOCALAPPDATA\opencode-voice-phonon\models\.phonon-2.5-*" -ErrorAction SilentlyContinue
```

```bash
# macOS
rm -f "$HOME/Library/Caches/opencode-voice-phonon/models/.phonon-2.5-"*
# Linux
rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/opencode-voice-phonon/models/.phonon-2.5-"*
```

If it keeps failing, verify the hash manually (previous section) and use a
manual install. A mismatch aborts before extraction, so no bad weights are
installed.

## `model_unpack` or `model_load`

**Cause:** the archive was malformed or did not contain
`c_weights/{weights.bin,weights.json,tokens.txt}`, or the C engine rejected the
weights.

**Fix:** delete the cache (see [Reset the model cache](#reset-the-model-cache))
and download again. If you are using a custom `modelDir`, confirm it points at
the directory that directly contains the three files, not at its parent.
`voice-core models status` reports what the sidecar resolves.

On Windows, the vendored C engine opens the weight files through the ANSI
filesystem API. If your Windows profile path contains non-ASCII characters,
point `OPENCODE_VOICE_MODEL_DIR` at an ASCII directory such as
`C:\opencode-voice-phonon-models` and reinstall the model there. A wide-character
loader is planned.

## Windows SmartScreen warning

**Cause:** the Windows executable is unsigned in 0.1.0.

**Fix:** choose **More info → Run anyway**, or avoid the prompt by building
from source. If the file came from anywhere other than the npm package, verify
its origin before running it. Signing is future work.

## First use looks hung

**Cause:** the first `start` downloads 183 MB, verifies it, unpacks 255 MB, and
loads the engine. The footer shows `model N%` when the server sends
`Content-Length`, otherwise just `preparing`.

**Fix:** wait. On a slow connection this can take minutes. To do it ahead of
time:

```bash
voice-core models install
```

Once files are cached, load time is about 0.03 s and recordings start
immediately. The download cannot be cancelled mid-flight in 0.1.0; if you must
stop it, quit OpenCode, remove the `.part` file, and retry later.

## "No speech detected" / empty transcript

**Cause:** the microphone is muted, the wrong device is the default, the
recording was too short, or the audio was silence/noise.

**Fix:**

- Confirm the device: `voice-core devices`, then check the OS default input.
- Watch the footer: it should read `listening` before you speak.
- Speak for at least 2–3 seconds. A very short clip may produce no finalized
  window; the plugin falls back to the partial, but silence yields nothing.
- Close applications that grab the microphone exclusively and try again.

## "Voice is still preparing the model" / "still transcribing"

**Cause:** the toggle is ignored while the sidecar is in `preparing` or
`transcribing`; only `listening` can be stopped.

**Fix:** wait for the footer to return to idle. The first `start` includes the
model work; `stop` includes decoding the final 25–35 s window. Starting a new
recording during either phase is intentionally rejected.

## High CPU during transcription

**Cause:** Phonon-2.5 decodes on the CPU with the engine's thread pool. Long
recordings and the final window are the expensive parts.

**Fix:** this is expected. Stop the recording when you are done; do not leave a
session listening in the background. The reference measurement used 4 threads
and processed a 10.97 s clip in 0.87 s. If the machine is thermally limited,
reduce recording length. There is no thread-count option in 0.1.0.

## Linux: ALSA library missing

**Cause:** `cpal` uses ALSA; the runtime library is not installed.

**Fix:**

```bash
# Debian / Ubuntu
sudo apt-get install -y libasound2
# Fedora
sudo dnf install alsa-lib
```

If you are building from source, the headers are also required:

```bash
sudo apt-get install -y libasound2-dev pkg-config   # Debian / Ubuntu
sudo dnf install alsa-lib-devel pkg-config          # Fedora
```

Then verify with `voice-core devices`.

## Reset the model cache

Delete the cache and let the next `start` or `models install` rebuild it. This
is safe: the model is reproducible from the pinned archive.

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode-voice-phonon\models"
```

```bash
# macOS
rm -rf "$HOME/Library/Caches/opencode-voice-phonon/models"
# Linux
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode-voice-phonon/models"
```

If you set `OPENCODE_VOICE_MODEL_DIR` or the `modelDir` option, delete that
directory instead. Also remove any `.phonon-2.5-*.tar.gz.part` and
`.phonon-2.5-*.extract` leftovers in the cache root.

## `voice-core exited (code N)` or a spawn error

**Cause:** the sidecar crashed or could not start — missing binary, wrong
architecture, missing ALSA, or an unsupported CPU.

**Fix:**

1. Run the binary directly from a terminal. `voice-core` is deliberately not
   put on `PATH`; use the packaged absolute path:

   ```bash
   "<package>/bin/<platform>-<arch>/voice-core[.exe]" --version
   "<package>/bin/<platform>-<arch>/voice-core[.exe]" devices
   "<package>/bin/<platform>-<arch>/voice-core[.exe]" models status
   ```

   For a normal npm install, `<package>` is
   `node_modules/opencode-voice-phonon` (under the OpenCode config directory or the
   project).

2. Run OpenCode with `OPENCODE_VOICE_DEBUG=1` and retry to capture stderr.
3. Confirm the packaged file exists and matches the platform:
   `<package>/bin/<platform>-<arch>/voice-core[.exe]`.
4. On Windows, confirm the CPU supports AVX2 (the release build targets it).
5. On Linux, install the ALSA runtime library.
6. Reinstall the package if the binary is missing or truncated.

The plugin resets its state and spawns a fresh sidecar on the next start, so a
transient crash does not require restarting OpenCode.

## Unsupported platform

**Cause:** no binary is published for this OS/architecture.

**Fix:** use one of `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`. Windows arm64 and 32-bit builds are not supported in 0.1.0.
Building for a new target is covered in
[`development.md`](development.md#adding-a-platform); until then, build from
source and set `OPENCODE_VOICE_BIN` to the resulting executable.

## The review dialog does not submit

**Cause:** the dialog was cancelled (Esc), the text was emptied, or
`session.prompt` failed.

**Fix:** reopen the recording and press Enter with non-empty text. A failed
submission shows `Could not submit prompt: ...`; check that the session still
exists and that the local OpenCode server is reachable. To skip the dialog
entirely, set `"review": false` — but note there is then no edit step before
the prompt is sent.

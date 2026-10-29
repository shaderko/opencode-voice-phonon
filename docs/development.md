# Development

This guide covers building, testing, packaging and releasing `opencode-voice-phonon`.
For the runtime design, read [`architecture.md`](architecture.md); for the wire
contract, read [`protocol.md`](protocol.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20+ (CI uses 22) | `npm` included. |
| Rust | stable | `rustup` is the easiest way to get the right target. |
| Platform C toolchain | — | See below; `build.rs` compiles the vendored C engine. |

### Windows

- Visual Studio 2022 Build Tools with the **Desktop development with C++**
  workload (MSVC, Windows SDK).
- The `x86_64-pc-windows-msvc` Rust toolchain (`rustup default stable-msvc`).
- An AVX2-capable x64 CPU: the release build compiles the C kernels for AVX2.

### macOS

- Xcode Command Line Tools: `xcode-select --install`.
- Rust targets as needed:
  `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- Microphone permission for the terminal app when running locally.

### Linux

- Debian/Ubuntu:
  `sudo apt-get update && sudo apt-get install -y libasound2-dev pkg-config`
- Fedora: `sudo dnf install alsa-lib-devel pkg-config`
- At runtime the user needs the ALSA shared library (`libasound2` on Debian
  family), not just the headers.

## Setup and checks

```bash
npm install
npm run typecheck
npm test
npm run build:gui

cargo fmt --check --manifest-path native/Cargo.toml
cargo test --manifest-path native/Cargo.toml
cargo build --release --manifest-path native/Cargo.toml
```

`npm test` runs the Vitest suites (82 tests): config normalization, protocol
parsing, platform resolution, state reduction, backend lifecycle, and the
Desktop GUI Ipc/composer bridge with mocked Desktop contexts.
`cargo test` runs the Rust tests (25 tests): CLI helpers, model path
safety/cache resolution, audio downmix, FFI invariants, and a streaming smoke
test. The streaming test returns early unless `OPENCODE_VOICE_MODEL_DIR` is
set. Neither suite needs a microphone, the model, or a running OpenCode by
default.

Useful variants:

```bash
npm run test:watch
cargo check --manifest-path native/Cargo.toml
cargo build --manifest-path native/Cargo.toml          # debug, faster
```

`npm run build:native` is a shortcut for the release build;
`npm run check:binaries` wraps `node scripts/check-binaries.mjs`.

## Desktop GUI bundle

The GUI is a single CommonJS bundle, not source shipped to Desktop:

```bash
npm run build:gui          # src/gui.tsx -> dist/gui-experimental.cjs
npm run build:gui -- --watch
```

- `vite.config.ts` uses `@opencode/plugin/gui/vite`, which compiles Solid JSX,
  inlines dynamic imports, and keeps `@opencode/plugin/gui`, `solid-js`,
  `effect` and Node/Electron built-ins external.
- `src/gui.tsx` has both `setup` (window: `ComposerPill`, `Command`) and
  `main` (Electron main: one `VoiceBackend`, `ctx.provide(VoiceIpc, ...)`).
- `src/gui-contract.ts` defines the `voice.phonon.voice` Ipc with Effect
  schemas. The id must stay under the server plugin id `voice.phonon`.
- `npm pack` and `npm publish` run `prepack`, so the bundle is rebuilt before
  packaging. `dist/` is git-ignored but included in the npm tarball.
- Desktop reads plugins from the **global** `opencode.json(c)`, not `cli.json`.
  A local plugin directory needs `name` and `exports` in `package.json`; the
  bundle must be `.cjs` or `.js`.
- The GUI logic test (`tests/gui.test.ts`) mocks the Desktop SDK, runs `main`
  to capture the Ipc implementation, then drives `setup` through start, a
  listening event, stop, and `composer.insert`. It does not launch Electron.

A real Desktop smoke test still requires launching OpenCode Desktop with the
plugin in the global config and granting microphone permission.

## Running the sidecar by hand

The binary is the same one the plugin spawns. A protocol smoke test needs no
microphone or model:

```bash
# macOS / Linux / Git Bash
printf '%s\n' '{"v":1,"type":"ping","id":1}' '{"v":1,"type":"shutdown"}' \
  | ./native/target/release/voice-core stream
```

```powershell
# Windows PowerShell
@'
{"v":1,"type":"ping","id":1}
{"v":1,"type":"shutdown"}
'@ | .\native\target\release\voice-core.exe stream
```

Expected: a `hello` line, then `pong`, then exit 0. For an actual recording,
run `voice-core stream` interactively, paste `{"v":1,"type":"start"}`, speak,
paste `{"v":1,"type":"stop"}`, then `shutdown`. Events appear on stdout;
diagnostics go to stderr.

One-shot CLI modes:

```bash
voice-core --version
voice-core --help
voice-core devices
voice-core models status
voice-core models install
voice-core transcribe tests/data/4077-13754-0014.wav --model-dir <dir>
voice-core transcribe tests/data/4077-13754-0014.wav --json
```

`models status` prints JSON with `installed`, `dir` and `bytes`. `models
install` downloads and verifies the model, printing progress to stderr and the
final directory to stdout. `transcribe` accepts 8/16/24/32-bit integer or float
WAV, downmixes to mono, and prints the joined transcript.

## End-to-end transcription

`scripts/e2e.mjs` runs the built binary against the 10.97 s LibriSpeech clip
and checks that the transcript is non-empty and shares distinctive words with
`tests/data/4077-13754-0014.txt`. It never downloads the model; point it at an
installed directory containing `weights.bin`, `weights.json` and `tokens.txt`.

```bash
# Windows PowerShell
node scripts/e2e.mjs --model-dir "$env:LOCALAPPDATA\opencode-voice-phonon\models\phonon-2.5-c-weights-v1"

# macOS
node scripts/e2e.mjs --model-dir "$HOME/Library/Caches/opencode-voice-phonon/models/phonon-2.5-c-weights-v1"

# Linux
node scripts/e2e.mjs --model-dir "${XDG_CACHE_HOME:-$HOME/.cache}/opencode-voice-phonon/models/phonon-2.5-c-weights-v1"
```

Pass `--wav <path>` for another 16 kHz mono file, `--binary <path>` for a
different executable, or `--json` to require JSON output. Exit codes: `0`
pass, `1` failure, `2` missing prerequisite (binary, WAV, or model).

To install the model first without the TUI:

```bash
./native/target/release/voice-core models install
```

The CI `e2e` job runs only on manual `workflow_dispatch` with `run_e2e`
enabled; it downloads the archive, verifies the same SHA-256, extracts it, and
passes `--model-dir "$RUNNER_TEMP/model/c_weights"`.

## Running the plugin from source

Build the sidecar, then let the plugin find the development binary:

```bash
npm run build:native
OPENCODE_VOICE_DEV=1 opencode
```

`OPENCODE_VOICE_DEV=1` resolves `native/target/release/voice-core[.exe]`
instead of `bin/`. On Windows PowerShell:

```powershell
$env:OPENCODE_VOICE_DEV = "1"
opencode
```

To point at an arbitrary binary (for example a debug build or a cross-built
artifact), use an absolute path:

```bash
OPENCODE_VOICE_BIN="$PWD/native/target/debug/voice-core" opencode
```

The plugin loads from the working tree when OpenCode is configured with a local
package path (see `examples/opencode.jsonc`); no publish or `npm link` is
required for development. Rebuild and restart OpenCode after changing Rust
code; the TUI part is loaded per session.

## Packaging a platform

```bash
npm run build:native                       # host release binary
npm run package:native                     # -> bin/<host-key>/voice-core[.exe]
node scripts/check-binaries.mjs            # report all five keys
```

`package-native.mjs` also accepts an explicit target and source, which is how
CI packages each matrix entry:

```bash
node scripts/package-native.mjs --target linux-arm64 \
  --source native/target/aarch64-unknown-linux-gnu/release/voice-core
```

Keys: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.
The script refuses a source at or below 1 MiB so a stub or a debug placeholder
cannot be published as a release binary. `check-binaries.mjs --require-all`
exits non-zero if any key is missing or too small; `--json` is available for
tooling.

Inspect the npm tarball before publishing:

```bash
npm pack --dry-run
```

The package includes `src/`, `bin/`, `dist/`, `docs/`, `examples/`,
`README.md`, `LICENSE` and `NOTICE`. `prepack` rebuilds
`dist/gui-experimental.cjs`. A tarball with one platform was measured at
1.4 MB compressed; five binaries make it correspondingly larger.

## Adding a platform

1. Add the key to `SUPPORTED_PLATFORMS` in `src/platform.ts` and to
   `SUPPORTED_KEYS` in `scripts/package-native.mjs` and
   `scripts/check-binaries.mjs` (all three lists must match).
2. Add a `TARGET_SOURCES` entry in `scripts/package-native.mjs` if the Rust
   target directory differs from the default layout.
3. Add a matrix entry to `.github/workflows/ci.yml` and
   `.github/workflows/release.yml` with OS, Rust target and binary path.
4. Check `native/build.rs` flags for the target (SIMD, C11, threading, link
   libraries). macOS arm64 uses `-mcpu=apple-m1`; x64 uses `-mavx2 -mfma`;
   Windows uses MSVC equivalents.
5. Verify `cpal` input support and, on Linux, ALSA availability.
6. Extend the platform tests in `tests/platform.test.ts` and the platform-key
   test in `native/src/main.rs`.
7. Build and package on a native runner; cross-compiling the C engine is not
   supported by the current scripts.

## Changing the protocol

`docs/protocol.md` is the contract. A change touches four places and must stay
in lockstep:

1. `docs/protocol.md` — commands, events, ordering, error codes.
2. `src/protocol.ts` — types, `parseEvent`, `encodeCommand`.
3. `native/src/protocol.rs` — serialization/deserialization.
4. `tests/protocol.test.ts` — parser coverage for the new shape.

Keep `"v": 1` while the shape is compatible. Bump the version for a breaking
change; both sides already reject unknown versions and surface
`protocol_mismatch` as an error event. Add a Rust test for any new state
transition or ordering rule.

## Debugging

| Setting | Effect |
| --- | --- |
| `OPENCODE_VOICE_DEBUG=1` | Forwards every `voice-core` stderr line to the OpenCode process stderr. Run `opencode` from a terminal to see it. |
| `OPENCODE_VOICE_BIN=/abs/path` | Use a specific sidecar binary. Must exist or startup fails with a clear error. |
| `OPENCODE_VOICE_DEV=1` | Use `native/target/release/voice-core[.exe]`. |
| `OPENCODE_VOICE_MODEL_DIR=/abs/dir` | Exact model directory; also settable with the `modelDir` plugin option. |

```bash
OPENCODE_VOICE_DEBUG=1 opencode
```

Typical signals:

- `voice-core exited (code N)` — run the binary directly: `voice-core
  --version`, `voice-core devices`, `voice-core models status`.
- `Unsupported platform` — check `node -p "process.platform + '-' +
  process.arch"` against the five keys.
- `voice-core is not packaged for ...` — build/package locally or set
  `OPENCODE_VOICE_DEV=1`.
- No `hello` — the binary was built without the C engine or is not the release
  artifact; check `voice-core --version` and the file size.

The TUI keeps only the last 40 stderr lines. Increase observability with the
debug flag rather than editing the ring size.

## Release process

1. Bump the version in `package.json` and `native/Cargo.toml` (the `hello`
   event's `version` comes from Cargo), and update any version references in
   docs.
2. Run the full local checks: `npm run typecheck`, `npm test`, `cargo fmt
   --check`, `cargo test`, release build, `npm run package:native`,
   `node scripts/check-binaries.mjs`, and the e2e script with a real model.
3. Commit, then tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. `.github/workflows/release.yml` builds all five targets, uploads `bin/`,
   runs `check-binaries.mjs --require-all`, and publishes with
   `npm publish --access public` using the `NPM_TOKEN` secret.
5. Verify the published tarball contains all five binaries and the docs:
   `npm view opencode-voice-phonon dist.tarball`, then inspect it locally.

The workflow uses `permissions: contents: read`; publishing relies on the npm
token only. There is no signing step for the Windows executable in 0.1.0.

#!/usr/bin/env node
/**
 * Copy a built voice-core binary into the npm package layout:
 *   bin/<platform>-<arch>/voice-core[.exe]
 *
 * Usage:
 *   node scripts/package-native.mjs [--target <key>] [--source <path>]
 *
 * Without arguments the host binary from native/target/release is packaged for
 * the host platform. Other platform binaries in bin/ are left untouched.
 */
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MIN_BYTES = 1024 * 1024

/** Supported platform keys, mirroring src/platform.ts. */
const SUPPORTED_KEYS = [
  "win32-x64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
]

/** Explicit rust target dir per platform key (used when --target has no --source). */
const TARGET_SOURCES = {
  "win32-x64": "native/target/x86_64-pc-windows-msvc/release/voice-core.exe",
  "darwin-arm64": "native/target/aarch64-apple-darwin/release/voice-core",
  "darwin-x64": "native/target/x86_64-apple-darwin/release/voice-core",
  "linux-x64": "native/target/x86_64-unknown-linux-gnu/release/voice-core",
  "linux-arm64": "native/target/aarch64-unknown-linux-gnu/release/voice-core",
}

function binaryName(key) {
  return key.startsWith("win32-") ? "voice-core.exe" : "voice-core"
}

function display(path) {
  const rel = relative(repoRoot, path)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function usage() {
  const keys = SUPPORTED_KEYS.map((key) => `    ${key}`).join("\n")
  console.log(
    [
      "Usage: node scripts/package-native.mjs [--target <key>] [--source <path>]",
      "",
      "Copies a built voice-core binary into bin/<key>/ for npm packaging.",
      "",
      "Options:",
      "  --target <key>   Package for a named platform key (default: host platform).",
      "  --source <path>  Source binary (default: native/target/release/voice-core[.exe],",
      "                   or the host-specific rust target dir when --target is given).",
      "  --help, -h       Show this help and exit.",
      "",
      "Supported keys:",
      keys,
    ].join("\n"),
  )
}

/** Parse --flag value and --flag=value forms. */
function parseArgs(argv) {
  const parsed = { help: false, target: undefined, source: undefined }
  const takeValue = (name, inline, index) => {
    if (inline !== undefined) return { value: inline, index }
    const next = argv[index + 1]
    if (!next || next.startsWith("-")) {
      fail(`${name} requires a value. Run "node scripts/package-native.mjs --help" for usage.`)
    }
    return { value: next, index: index + 1 }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const [name, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    switch (name) {
      case "--help":
      case "-h":
        parsed.help = true
        break
      case "--target": {
        const taken = takeValue("--target", inline, i)
        parsed.target = taken.value
        i = taken.index
        break
      }
      case "--source": {
        const taken = takeValue("--source", inline, i)
        parsed.source = taken.value
        i = taken.index
        break
      }
      default:
        fail(`unknown argument "${arg}". Run "node scripts/package-native.mjs --help" for usage.`)
    }
  }
  return parsed
}

function hostKey() {
  return `${process.platform}-${process.arch}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const key = args.target ?? hostKey()
  if (!SUPPORTED_KEYS.includes(key)) {
    fail(
      `unsupported platform key "${key}". Supported keys: ${SUPPORTED_KEYS.join(", ")}. ` +
        `Pass --target <key> to package for a different platform.`,
    )
  }

  const name = binaryName(key)
  const source = args.source
    ? resolve(repoRoot, args.source)
    : args.target
      ? resolve(repoRoot, TARGET_SOURCES[key])
      : resolve(repoRoot, "native", "target", "release", name)

  let stats
  try {
    stats = statSync(source)
  } catch {
    fail(
      `source binary not found: ${display(source)}. ` +
        `Build it with "npm run build:native" or pass --source <path>.`,
    )
  }
  if (!stats.isFile()) {
    fail(`source is not a file: ${display(source)}. Pass --source <path> to a voice-core binary.`)
  }
  if (stats.size <= MIN_BYTES) {
    fail(
      `source binary is too small (${stats.size} bytes): ${display(source)}. ` +
        `Expected a release build larger than ${MIN_BYTES} bytes; rebuild with "npm run build:native".`,
    )
  }

  const destDir = resolve(repoRoot, "bin", key)
  const dest = join(destDir, name)
  try {
    mkdirSync(destDir, { recursive: true })
    copyFileSync(source, dest)
  } catch (error) {
    fail(`could not copy ${display(source)} -> ${display(dest)}: ${error.message}`)
  }

  if (!key.startsWith("win32-")) {
    try {
      chmodSync(dest, 0o755)
    } catch {
      // Best effort: filesystems without POSIX modes (e.g. cross-packaging on Windows).
    }
  }

  console.log(`packaged ${display(source)} -> ${display(dest)} (${stats.size})`)
}

main()

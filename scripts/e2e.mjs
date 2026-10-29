#!/usr/bin/env node
/**
 * End-to-end check for voice-core transcription.
 *
 * Runs the built voice-core binary against a WAV file and a model directory,
 * then asserts that the transcript is non-empty and, when a reference text is
 * available next to the WAV, that it resembles the reference. This script never
 * downloads the 183 MB model; the user or CI provides it.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { dirname, join, parse as parsePath, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const DEFAULT_WAV = join(REPO_ROOT, "tests", "data", "4077-13754-0014.wav")
const DEFAULT_BINARY = join(
  REPO_ROOT,
  "native",
  "target",
  "release",
  process.platform === "win32" ? "voice-core.exe" : "voice-core",
)
const MODEL_DIR_NAME = "phonon-2.5-c-weights-v1"
const MODEL_FILES = ["weights.bin", "weights.json", "tokens.txt"]
const MODEL_URL =
  "https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz"
const MODEL_SHA256 =
  "ed622ca97bc4ec044c7ba5fb69c10985b1b3897e600dbf611840d9a0692b4cfe"
const TIMEOUT_MS = 120_000
const MAX_BUFFER = 32 * 1024 * 1024
const STDERR_TAIL = 4000

const USAGE = `
Usage: node scripts/e2e.mjs [options]

Runs voice-core transcribe against a WAV file and a model directory and checks
the resulting transcript. Exit codes: 0 pass, 1 failure, 2 missing prerequisite.

Options:
  --wav <path>        WAV file to transcribe.
                      Default: tests/data/4077-13754-0014.wav
  --model-dir <dir>   Directory containing weights.bin, weights.json and
                      tokens.txt. Default: OPENCODE_VOICE_MODEL_DIR, else the
                      platform model cache.
  --binary <path>     voice-core executable.
                      Default: native/target/release/voice-core[.exe]
  --json              Pass --json to voice-core and parse its JSON output.
  -h, --help          Show this help and exit.

Environment:
  OPENCODE_VOICE_MODEL_DIR   Model directory when --model-dir is omitted.

The model is not downloaded by this script. The reference transcript is read
from the .txt file next to the WAV when one exists.
`.trim()

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "almost",
  "along",
  "already",
  "although",
  "among",
  "another",
  "because",
  "before",
  "being",
  "between",
  "both",
  "could",
  "during",
  "each",
  "every",
  "from",
  "have",
  "having",
  "into",
  "itself",
  "more",
  "most",
  "much",
  "must",
  "never",
  "only",
  "other",
  "over",
  "same",
  "should",
  "since",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "within",
  "without",
  "would",
])

class UsageError extends Error {}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function expandHome(value) {
  if (value === "~") return process.env.HOME || process.env.USERPROFILE || value
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE
    if (home) return join(home, value.slice(2))
  }
  return value
}

function resolveUserPath(value, base = process.cwd()) {
  return resolve(base, expandHome(value))
}

function defaultCacheDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      return join(localAppData, "opencode-voice-phonon", "models", MODEL_DIR_NAME)
    }
    const profile = process.env.USERPROFILE || process.env.HOME
    if (profile) {
      return join(
        profile,
        "AppData",
        "Local",
        "opencode-voice-phonon",
        "models",
        MODEL_DIR_NAME,
      )
    }
    return `%LOCALAPPDATA%\\opencode-voice-phonon\\models\\${MODEL_DIR_NAME}`
  }

  if (process.platform === "darwin") {
    const home = process.env.HOME || process.env.USERPROFILE
    if (home) {
      return join(home, "Library", "Caches", "opencode-voice-phonon", "models", MODEL_DIR_NAME)
    }
    return `~/Library/Caches/opencode-voice-phonon/models/${MODEL_DIR_NAME}`
  }

  const cacheRoot = process.env.XDG_CACHE_HOME
  if (cacheRoot) {
    return join(cacheRoot, "opencode-voice-phonon", "models", MODEL_DIR_NAME)
  }
  const home = process.env.HOME
  if (home) {
    return join(home, ".cache", "opencode-voice-phonon", "models", MODEL_DIR_NAME)
  }
  return `~/.cache/opencode-voice-phonon/models/${MODEL_DIR_NAME}`
}

function parseArgs(argv) {
  const options = {
    wav: undefined,
    modelDir: undefined,
    binary: undefined,
    json: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    let name = raw
    let inlineValue

    if (raw.startsWith("--")) {
      const equals = raw.indexOf("=")
      if (equals !== -1) {
        name = raw.slice(0, equals)
        inlineValue = raw.slice(equals + 1)
      }
    }

    const takeValue = () => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) {
          throw new UsageError(`missing value for ${name}`)
        }
        return inlineValue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        throw new UsageError(`missing value for ${name}`)
      }
      i += 1
      return next
    }

    switch (name) {
      case "--wav":
        options.wav = takeValue()
        break
      case "--model-dir":
        options.modelDir = takeValue()
        break
      case "--binary":
        options.binary = takeValue()
        break
      case "--json":
        options.json = true
        break
      default:
        throw new UsageError(`unknown option: ${raw}`)
    }
  }

  return options
}

function findBinary(requested) {
  const candidate = requested ? resolveUserPath(requested) : DEFAULT_BINARY
  if (isFile(candidate)) return candidate
  if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
    const exe = `${candidate}.exe`
    if (isFile(exe)) return exe
  }
  return candidate
}

function modelFilesMissing(dir) {
  const missing = []
  for (const name of MODEL_FILES) {
    const file = join(dir, name)
    if (!isFile(file)) {
      missing.push(name)
      continue
    }
    if (name === "weights.bin") {
      try {
        if (statSync(file).size === 0) missing.push(`${name} (empty)`)
      } catch {
        missing.push(name)
      }
    }
  }
  return missing
}

function printModelHelp(dir, missing) {
  console.error("Model directory is missing or incomplete:")
  console.error(`  ${dir}`)
  if (missing.length > 0) console.error(`  missing: ${missing.join(", ")}`)
  console.error("")
  console.error("voice-core needs one directory containing all three files:")
  console.error("  weights.bin, weights.json, tokens.txt")
  console.error("")
  console.error("Download the weights once, then unpack them into that directory:")
  console.error(`  ${MODEL_URL}`)
  console.error(`  SHA-256: ${MODEL_SHA256}`)
  console.error("")
  console.error("Default cache location:")
  console.error("  Windows: %LOCALAPPDATA%\\opencode-voice-phonon\\models\\" + MODEL_DIR_NAME)
  console.error("  macOS:   ~/Library/Caches/opencode-voice-phonon/models/" + MODEL_DIR_NAME)
  console.error(
    "  Linux:   $XDG_CACHE_HOME/opencode-voice-phonon/models/" +
      MODEL_DIR_NAME +
      " (default ~/.cache/opencode-voice-phonon/models/" +
      MODEL_DIR_NAME +
      ")",
  )
  console.error(`  This platform: ${defaultCacheDir()}`)
  console.error("")
  console.error("Point OPENCODE_VOICE_MODEL_DIR or --model-dir at the directory.")
  console.error("This script never downloads the model.")
}

function printBinaryHelp(binary) {
  console.error("voice-core binary not found:")
  console.error(`  ${binary}`)
  console.error("")
  console.error("Build it first:")
  console.error(
    `  cargo build --release --manifest-path "${join(REPO_ROOT, "native", "Cargo.toml")}"`,
  )
  console.error("  # or from the repo root: npm run build:native")
  console.error("")
  console.error("Pass --binary <path> to use a different executable.")
}

function formatCommand(parts) {
  return parts
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ")
}

function tail(text, limit = STDERR_TAIL) {
  const value = String(text ?? "")
  if (value.length <= limit) return value.trimEnd() || "(empty)"
  const omitted = value.length - limit
  return `... ${omitted} characters omitted ...\n${value.slice(-limit).trimEnd()}`
}

function fail(reason, details = {}) {
  console.error(`FAIL: ${reason}`)
  if (details.command) console.error(`command: ${details.command}`)
  if (details.status !== undefined && details.status !== null) {
    console.error(`exit code: ${details.status}`)
  }
  if (details.signal) console.error(`signal: ${details.signal}`)
  if (details.transcript !== undefined) {
    console.error(`transcript: ${details.transcript || "(empty)"}`)
  }
  if (details.stdout !== undefined) {
    console.error(`stdout: ${details.stdout ? `\n${tail(details.stdout)}` : "(empty)"}`)
  }
  if (details.stderr !== undefined) {
    console.error(`stderr: ${details.stderr ? `\n${tail(details.stderr)}` : "(empty)"}`)
  }
  return 1
}

function tryParse(text) {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

function collectText(value, depth = 0) {
  if (depth > 8) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) => collectText(item, depth + 1))
      .filter(Boolean)
      .join(" ")
  }
  if (value === null || typeof value !== "object") return ""

  for (const key of ["text", "transcript", "transcription", "final", "result", "output"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const text = collectText(value[key], depth + 1)
      if (text) return text
    }
  }

  for (const key of ["segments", "words", "events", "results", "data"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const text = collectText(value[key], depth + 1)
      if (text) return text
    }
  }

  return ""
}

function parseOutput(stdout) {
  const raw = stdout.trim()
  if (!raw) return { transcript: "", sawJson: false }

  const direct = tryParse(raw)
  if (direct) {
    const transcript = collectText(direct.value)
    return { transcript, sawJson: true }
  }

  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  const candidates = []
  if (lines.length > 1) candidates.push(lines[lines.length - 1])

  const firstObject = raw.indexOf("{")
  const lastObject = raw.lastIndexOf("}")
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(raw.slice(firstObject, lastObject + 1))
  }

  const firstArray = raw.indexOf("[")
  const lastArray = raw.lastIndexOf("]")
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(raw.slice(firstArray, lastArray + 1))
  }

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (!parsed) continue
    const transcript = collectText(parsed.value)
    if (transcript) return { transcript, sawJson: true }
  }

  let sawJson = false
  const chunks = []
  const textLines = []

  for (const line of lines) {
    const parsed = tryParse(line)
    if (!parsed) {
      textLines.push(line)
      continue
    }
    sawJson = true
    const transcript = collectText(parsed.value)
    if (transcript) chunks.push(transcript)
  }

  if (chunks.length > 0) {
    return { transcript: chunks.join(" "), sawJson: true }
  }
  if (textLines.length > 0) {
    return { transcript: textLines.join("\n"), sawJson }
  }
  return { transcript: "", sawJson }
}

function normalizeTranscript(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim()
}

function looksLikeNonTranscript(text) {
  const value = text.trim()
  if (/^voice-core\s+v?\d+(?:\.\d+){1,3}$/iu.test(value)) return true
  if (/^usage:/iu.test(value)) return true
  return false
}

function probeFor(word) {
  const length = Math.min(word.length, Math.max(5, Math.ceil(word.length * 0.7)))
  return word.slice(0, length)
}

function referenceKeywords(reference) {
  const words = reference.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? []
  const sorted = [...new Set(words)]
    .filter((word) => word.length >= 6 && !STOP_WORDS.has(word))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))

  const seen = new Set()
  const keywords = []
  for (const word of sorted) {
    const stem = probeFor(word).slice(0, 5)
    if (seen.has(stem)) continue
    seen.add(stem)
    keywords.push(word)
    if (keywords.length === 6) break
  }
  return keywords
}

function checkReference(wavPath, transcript) {
  const parsed = parsePath(wavPath)
  const referencePath = join(parsed.dir, `${parsed.name}.txt`)
  if (!isFile(referencePath)) return null

  let reference
  try {
    reference = readFileSync(referencePath, "utf8")
  } catch {
    return null
  }

  const keywords = referenceKeywords(reference)
  if (keywords.length < 3) {
    return {
      path: referencePath,
      keywords,
      hits: 0,
      matched: [],
      required: false,
    }
  }

  const haystack = transcript.toLowerCase()
  const matched = keywords.filter((word) => haystack.includes(probeFor(word)))
  return {
    path: referencePath,
    keywords,
    hits: matched.length,
    matched,
    required: true,
  }
}

function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return 0
  }

  const options = parseArgs(argv)

  const wavPath = options.wav ? resolveUserPath(options.wav) : DEFAULT_WAV
  const modelDir = options.modelDir
    ? resolveUserPath(options.modelDir)
    : process.env.OPENCODE_VOICE_MODEL_DIR
      ? resolveUserPath(process.env.OPENCODE_VOICE_MODEL_DIR)
      : defaultCacheDir()
  const binary = findBinary(options.binary)

  if (!isFile(wavPath)) {
    console.error("Test WAV not found:")
    console.error(`  ${wavPath}`)
    console.error("")
    console.error(`The default clip is ${DEFAULT_WAV}.`)
    console.error("Pass --wav <path> to use another 16 kHz mono WAV file.")
    return 2
  }

  if (!isFile(binary)) {
    printBinaryHelp(binary)
    return 2
  }

  if (!isDirectory(modelDir)) {
    printModelHelp(modelDir, [])
    return 2
  }

  const missing = modelFilesMissing(modelDir)
  if (missing.length > 0) {
    printModelHelp(modelDir, missing)
    return 2
  }

  const cliArgs = ["transcribe", wavPath, "--model-dir", modelDir]
  if (options.json) cliArgs.push("--json")
  const command = formatCommand([binary, ...cliArgs])

  const result = spawnSync(binary, cliArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, OPENCODE_VOICE_MODEL_DIR: modelDir },
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  })

  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      return fail(`voice-core timed out after ${TIMEOUT_MS / 1000} s`, {
        command,
        signal: result.signal ?? undefined,
        stdout,
        stderr,
      })
    }
    return fail(`could not run voice-core: ${result.error.message}`, {
      command,
      stdout,
      stderr,
    })
  }

  if (result.signal) {
    return fail(`voice-core was terminated by ${result.signal}`, {
      command,
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
    })
  }

  if (result.status !== 0) {
    return fail(`voice-core exited with code ${result.status}`, {
      command,
      status: result.status,
      stdout,
      stderr,
    })
  }

  const parsed = parseOutput(stdout)
  let transcript

  if (parsed.transcript) {
    transcript = normalizeTranscript(parsed.transcript)
  } else if (options.json) {
    return fail("--json was requested but stdout did not contain a transcript", {
      command,
      status: result.status,
      stdout,
      stderr,
    })
  } else if (parsed.sawJson) {
    return fail("voice-core printed JSON but no transcript was found in it", {
      command,
      status: result.status,
      stdout,
      stderr,
    })
  } else {
    transcript = normalizeTranscript(stdout)
  }

  if (transcript.length === 0) {
    return fail("transcript is empty", {
      command,
      status: result.status,
      transcript,
      stdout,
      stderr,
    })
  }

  if (!/[\p{L}\p{N}]/u.test(transcript)) {
    return fail("transcript contains no letters or digits", {
      command,
      status: result.status,
      transcript,
      stderr,
    })
  }

  if (looksLikeNonTranscript(transcript)) {
    return fail(
      "voice-core printed a version banner or usage text instead of a transcript; the binary may be a stub build",
      {
        command,
        status: result.status,
        transcript,
        stderr,
      },
    )
  }

  const reference = checkReference(wavPath, transcript)
  if (reference && reference.required && reference.hits === 0) {
    return fail(
      `transcript has none of the reference's distinctive words (${reference.path})`,
      {
        command,
        status: result.status,
        transcript,
        stderr,
      },
    )
  }

  console.log("PASS")
  console.log(`transcript: ${transcript}`)
  if (reference) {
    const names = reference.matched.length > 0 ? reference.matched.join(", ") : "none"
    console.log(
      `reference: ${reference.hits}/${reference.keywords.length} distinctive words matched (${names})`,
    )
  }
  return 0
}

function main() {
  try {
    return run(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`)
      console.error("")
      console.error(USAGE)
      return 1
    }
    console.error(`FAIL: ${error && error.stack ? error.stack : error}`)
    return 1
  }
}

process.exitCode = main()

#!/usr/bin/env node
/**
 * Report which packaged voice-core binaries are present in bin/.
 *
 * Usage:
 *   node scripts/check-binaries.mjs [--require-all] [--json]
 *
 * Exits 0 even when binaries are missing unless --require-all is passed.
 */
import { statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
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

function binaryName(key) {
  return key.startsWith("win32-") ? "voice-core.exe" : "voice-core"
}

function usage() {
  console.log(
    [
      "Usage: node scripts/check-binaries.mjs [--require-all] [--json]",
      "",
      "Checks bin/<key>/voice-core[.exe] for every supported platform key.",
      "",
      "Options:",
      "  --require-all  Exit 1 when a binary is missing or too small.",
      "  --json         Print a JSON array instead of a table.",
      "  --help, -h     Show this help and exit.",
    ].join("\n"),
  )
}

function parseArgs(argv) {
  const parsed = { help: false, requireAll: false, json: false }
  for (const arg of argv) {
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true
        break
      case "--require-all":
        parsed.requireAll = true
        break
      case "--json":
        parsed.json = true
        break
      default:
        console.error(`error: unknown argument "${arg}". Run "node scripts/check-binaries.mjs --help".`)
        process.exit(1)
    }
  }
  return parsed
}

function inspect(key) {
  const relativePath = `bin/${key}/${binaryName(key)}`
  const absolutePath = join(repoRoot, ...relativePath.split("/"))
  let exists = false
  let bytes = 0
  try {
    const stats = statSync(absolutePath)
    exists = stats.isFile()
    if (exists) bytes = stats.size
  } catch {
    exists = false
  }
  const ok = exists && bytes > MIN_BYTES
  const status = !exists ? "missing" : ok ? "ok" : "too small"
  return { key, path: relativePath, present: ok, bytes, status }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const rows = SUPPORTED_KEYS.map(inspect)

  if (args.json) {
    console.log(
      JSON.stringify(
        rows.map(({ key, path, present, bytes }) => ({ key, path, present, bytes })),
        null,
        2,
      ),
    )
  } else {
    const keyWidth = Math.max(...rows.map((row) => row.key.length))
    const statusWidth = Math.max(...rows.map((row) => row.status.length))
    console.log(`${"key".padEnd(keyWidth)}  ${"status".padEnd(statusWidth)}  bytes`)
    for (const row of rows) {
      const size = row.bytes > 0 ? String(row.bytes) : "-"
      console.log(`${row.key.padEnd(keyWidth)}  ${row.status.padEnd(statusWidth)}  ${size}`)
    }
    const ready = rows.filter((row) => row.present).length
    console.log(`\n${ready}/${rows.length} binaries ready`)
  }

  const broken = rows.filter((row) => !row.present)
  if (args.requireAll && broken.length > 0) {
    const detail = broken
      .map((row) => `${row.key} (${row.status === "missing" ? "missing" : `too small: ${row.bytes} bytes`})`)
      .join(", ")
    console.error(`error: missing or too small voice-core binaries: ${detail}.`)
    console.error('Run "npm run build:native" and "npm run package:native", or pass --target <key>.')
    process.exit(1)
  }
}

main()

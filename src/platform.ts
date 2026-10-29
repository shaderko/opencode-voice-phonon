/**
 * Resolves the platform-specific voice-core binary shipped with this package.
 *
 * Packaged layout: bin/<platform>-<arch>/voice-core[.exe]
 * Development: native/target/release/voice-core[.exe] (OPENCODE_VOICE_DEV=1)
 */

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const SUPPORTED_PLATFORMS = [
  "win32-x64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const

export type PlatformKey = (typeof SUPPORTED_PLATFORMS)[number]

/** Returns the `platform-arch` key used to select a packaged binary. */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`
}

/** Returns the executable file name for a supported platform key. */
export function binaryName(key: string): string {
  return key.startsWith("win32-") ? "voice-core.exe" : "voice-core"
}

export function isSupported(key?: string): key is PlatformKey {
  return (
    typeof key === "string" &&
    (SUPPORTED_PLATFORMS as readonly string[]).includes(key)
  )
}

/**
 * Returns `<packageRoot>/bin/<key>/<binaryName>`.
 * Throws for an unsupported platform key rather than guessing.
 */
export function binaryPath(packageRoot: string, key: string = platformKey()): string {
  if (!isSupported(key)) {
    throw new Error(
      `Unsupported platform "${key}". Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    )
  }
  return join(packageRoot, "bin", key, binaryName(key))
}

/**
 * The package root is one directory above this module. This holds both for
 * `src/platform.ts` during development and `dist/platform.js` once built.
 */
export function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..")
}

/**
 * Resolve the voice-core executable in priority order:
 *   1. OPENCODE_VOICE_BIN (explicit override)
 *   2. native/target/release when OPENCODE_VOICE_DEV=1
 *   3. bin/<platform>-<arch> in the package
 *
 * Every candidate must exist; a missing binary is a clear, actionable error.
 */
export function resolveBinaryPath(): string {
  const packageRoot = resolvePackageRoot()
  const supported = SUPPORTED_PLATFORMS.join(", ")

  const override = process.env.OPENCODE_VOICE_BIN
  if (override) {
    const candidate = resolve(override)
    if (!existsSync(candidate)) {
      throw new Error(
        `OPENCODE_VOICE_BIN points to a missing voice-core binary: ${candidate}. Supported platforms: ${supported}.`,
      )
    }
    return candidate
  }

  const key = platformKey()

  if (process.env.OPENCODE_VOICE_DEV === "1") {
    const candidate = join(packageRoot, "native", "target", "release", binaryName(key))
    if (!existsSync(candidate)) {
      throw new Error(
        `OPENCODE_VOICE_DEV=1 but the development build is missing: ${candidate}. ` +
          `Run "cargo build --release --manifest-path native/Cargo.toml". Supported platforms: ${supported}.`,
      )
    }
    return candidate
  }

  const candidate = binaryPath(packageRoot, key)
  if (!existsSync(candidate)) {
    throw new Error(
      `voice-core is not packaged for ${key}: ${candidate}. Supported platforms: ${supported}.`,
    )
  }
  return candidate
}

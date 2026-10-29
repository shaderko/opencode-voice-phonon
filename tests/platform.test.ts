import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"

import { describe, expect, it } from "vitest"

import {
  SUPPORTED_PLATFORMS,
  binaryName,
  binaryPath,
  isSupported,
  platformKey,
  resolveBinaryPath,
  resolvePackageRoot,
} from "../src/platform.ts"

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe("platformKey", () => {
  it("joins platform and arch with a dash", () => {
    expect(platformKey("win32", "x64")).toBe("win32-x64")
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64")
    expect(platformKey("darwin", "x64")).toBe("darwin-x64")
    expect(platformKey("linux", "x64")).toBe("linux-x64")
    expect(platformKey("linux", "arm64")).toBe("linux-arm64")
  })

  it("does not normalize or map aliases", () => {
    expect(platformKey("freebsd", "x64")).toBe("freebsd-x64")
    expect(platformKey("win32", "arm64")).toBe("win32-arm64")
  })

  it("defaults to the current process platform and arch", () => {
    expect(platformKey()).toBe(`${process.platform}-${process.arch}`)
  })
})

describe("SUPPORTED_PLATFORMS", () => {
  it("contains exactly the five packaged targets", () => {
    expect(SUPPORTED_PLATFORMS).toEqual([
      "win32-x64",
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
    ])
  })
})

describe("binaryName", () => {
  it("adds .exe only for win32 keys", () => {
    expect(binaryName("win32-x64")).toBe("voice-core.exe")
    expect(binaryName("win32-arm64")).toBe("voice-core.exe")
  })

  it("uses a bare name for every other key", () => {
    expect(binaryName("darwin-arm64")).toBe("voice-core")
    expect(binaryName("darwin-x64")).toBe("voice-core")
    expect(binaryName("linux-x64")).toBe("voice-core")
    expect(binaryName("linux-arm64")).toBe("voice-core")
    expect(binaryName("freebsd-x64")).toBe("voice-core")
  })
})

describe("isSupported", () => {
  it("accepts every packaged platform", () => {
    for (const key of SUPPORTED_PLATFORMS) {
      expect(isSupported(key)).toBe(true)
    }
  })

  it("rejects unlisted, empty, or missing keys", () => {
    expect(isSupported("win32-arm64")).toBe(false)
    expect(isSupported("freebsd-x64")).toBe(false)
    expect(isSupported("linux-x64 ")).toBe(false)
    expect(isSupported("LINUX-X64")).toBe(false)
    expect(isSupported("")).toBe(false)
    expect(isSupported(undefined)).toBe(false)
  })
})

describe("binaryPath", () => {
  it("resolves the packaged layout for linux-x64", () => {
    const resolved = binaryPath("/pkg", "linux-x64")

    expect(resolved).toBe(join("/pkg", "bin", "linux-x64", "voice-core"))
    expect(resolved.split(sep)).toEqual(["", "pkg", "bin", "linux-x64", "voice-core"])
  })

  it("resolves the packaged layout for every supported platform", () => {
    for (const key of SUPPORTED_PLATFORMS) {
      expect(binaryPath("/pkg", key)).toBe(join("/pkg", "bin", key, binaryName(key)))
    }
  })

  it("uses the .exe name under win32", () => {
    const resolved = binaryPath("/pkg", "win32-x64")

    expect(resolved).toBe(join("/pkg", "bin", "win32-x64", "voice-core.exe"))
    expect(resolved.endsWith(".exe")).toBe(true)
  })

  it("throws for unsupported keys", () => {
    expect(() => binaryPath("/pkg", "win32-arm64")).toThrow(
      'Unsupported platform "win32-arm64". Supported platforms: win32-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64.',
    )
    expect(() => binaryPath("/pkg", "freebsd-x64")).toThrow(/Unsupported platform "freebsd-x64"/)
    expect(() => binaryPath("/pkg", "")).toThrow(/Unsupported platform ""/)
  })
})

describe("resolvePackageRoot", () => {
  it("returns an absolute directory containing package.json", () => {
    const root = resolvePackageRoot()

    expect(isAbsolute(root)).toBe(true)
    const manifest = join(root, "package.json")
    expect(existsSync(manifest)).toBe(true)
    expect(JSON.parse(readFileSync(manifest, "utf8")).name).toBe("opencode-voice-phonon")
  })

  it("is the repository root, not src", () => {
    const root = resolvePackageRoot()

    expect(existsSync(join(root, "src", "platform.ts"))).toBe(true)
    expect(existsSync(join(root, "src", "package.json"))).toBe(false)
  })
})

describe("resolveBinaryPath", () => {
  it("returns an existing OPENCODE_VOICE_BIN override", () => {
    const previous = process.env.OPENCODE_VOICE_BIN
    const override = join(resolvePackageRoot(), "package.json")

    process.env.OPENCODE_VOICE_BIN = override
    try {
      expect(resolveBinaryPath()).toBe(resolve(override))
    } finally {
      restoreEnv("OPENCODE_VOICE_BIN", previous)
    }
  })

  it("rejects a missing OPENCODE_VOICE_BIN override", () => {
    const previous = process.env.OPENCODE_VOICE_BIN
    const override = join(resolvePackageRoot(), "definitely-missing", "voice-core")

    process.env.OPENCODE_VOICE_BIN = override
    try {
      expect(() => resolveBinaryPath()).toThrow(
        `OPENCODE_VOICE_BIN points to a missing voice-core binary: ${resolve(override)}.`,
      )
    } finally {
      restoreEnv("OPENCODE_VOICE_BIN", previous)
    }
  })
})

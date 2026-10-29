import { describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS, resolveOptions } from "../src/config.ts"

const DEFAULTS = {
  keybind: "ctrl+space",
  review: true,
  showPartial: true,
}

describe("resolveOptions", () => {
  it("returns defaults for undefined", () => {
    expect(resolveOptions(undefined)).toEqual(DEFAULTS)
  })

  it("returns defaults for an empty object", () => {
    expect(resolveOptions({})).toEqual(DEFAULTS)
  })

  it("keeps valid overrides", () => {
    expect(
      resolveOptions({
        keybind: "ctrl+k",
        review: false,
        showPartial: false,
        modelDir: "/models/phonon",
      }),
    ).toEqual({
      keybind: "ctrl+k",
      review: false,
      showPartial: false,
      modelDir: "/models/phonon",
    })
  })

  it("falls back for wrong types", () => {
    const options = resolveOptions({
      keybind: 42,
      review: "yes",
      showPartial: 1,
      modelDir: 7,
    })

    expect(options).toEqual(DEFAULTS)
    expect(options.modelDir).toBeUndefined()
    expect("modelDir" in options).toBe(false)
  })

  it("falls back for empty or whitespace keybinds", () => {
    const invalid = ["", " ", "ctrl space", " ctrl+x", "ctrl+x ", "ctrl\tx", "ctrl\nx"]
    for (const keybind of invalid) {
      expect(resolveOptions({ keybind }).keybind).toBe("ctrl+space")
    }
  })

  it("omits an empty modelDir", () => {
    const options = resolveOptions({ modelDir: "" })
    expect(options.modelDir).toBeUndefined()
    expect("modelDir" in options).toBe(false)
  })

  it("ignores unknown keys and inherited properties", () => {
    const inherited = Object.create({ keybind: "ctrl+x" }) as Record<string, unknown>
    expect(resolveOptions(inherited)).toEqual(DEFAULTS)
    expect(resolveOptions({ keybind: "ctrl+x", extra: true })).toEqual({
      ...DEFAULTS,
      keybind: "ctrl+x",
    })
  })

  it("returns a fresh object that is not DEFAULT_OPTIONS", () => {
    const first = resolveOptions({})
    const second = resolveOptions({})

    expect(first).not.toBe(DEFAULT_OPTIONS)
    expect(first).not.toBe(second)

    first.keybind = "ctrl+y"
    first.review = false
    first.showPartial = false
    first.modelDir = "/tmp/models"

    expect(DEFAULT_OPTIONS).toEqual({
      keybind: "ctrl+space",
      review: true,
      showPartial: true,
      modelDir: undefined,
    })
    expect(resolveOptions({})).toEqual(DEFAULTS)
    expect(second).toEqual(DEFAULTS)
  })
})

export interface VoiceOptions {
  keybind: string
  review: boolean
  showPartial: boolean
  modelDir?: string
}

export const DEFAULT_OPTIONS: Readonly<VoiceOptions> = Object.freeze({
  keybind: "ctrl+space",
  review: true,
  showPartial: true,
  modelDir: undefined,
})

function readOwn(raw: unknown, key: string): unknown {
  if (raw === null || typeof raw !== "object") return undefined
  try {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined
    return (raw as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Normalizes the plugin options passed by OpenCode. Invalid or missing values
 * fall back to defaults; this never throws so a typo cannot break startup.
 */
export function resolveOptions(
  raw: Readonly<Record<string, unknown>> | undefined,
): VoiceOptions {
  const keybind = readOwn(raw, "keybind")
  const review = readOwn(raw, "review")
  const showPartial = readOwn(raw, "showPartial")
  const modelDir = readOwn(raw, "modelDir")

  const options: VoiceOptions = {
    keybind:
      typeof keybind === "string" && keybind.length > 0 && !/\s/.test(keybind)
        ? keybind
        : DEFAULT_OPTIONS.keybind,
    review: typeof review === "boolean" ? review : DEFAULT_OPTIONS.review,
    showPartial:
      typeof showPartial === "boolean" ? showPartial : DEFAULT_OPTIONS.showPartial,
  }

  if (typeof modelDir === "string" && modelDir.length > 0) {
    options.modelDir = modelDir
  }

  return options
}

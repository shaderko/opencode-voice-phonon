/**
 * The one contract between the TypeScript TUI plugin and the Rust voice-core sidecar.
 *
 * Transport: one JSON object per line. voice-core writes only JSONL events to
 * stdout; diagnostics go to stderr. The TUI writes JSONL commands to stdin.
 *
 * Keep this file and native/src/protocol.rs in lockstep.
 */

export const PROTOCOL_VERSION = 1 as const

export type CoreState = "idle" | "preparing" | "listening" | "transcribing"

export type ModelState = "downloading" | "extracting" | "loading" | "ready"

export type CoreEvent =
  | {
      v: typeof PROTOCOL_VERSION
      type: "hello"
      version: string
      model: string
      platform: string
    }
  | { v: typeof PROTOCOL_VERSION; type: "state"; state: CoreState }
  | {
      v: typeof PROTOCOL_VERSION
      type: "model"
      state: ModelState
      received?: number
      total?: number
    }
  | { v: typeof PROTOCOL_VERSION; type: "partial"; text: string }
  | {
      v: typeof PROTOCOL_VERSION
      type: "final"
      text: string
      start: number
      end: number
    }
  | { v: typeof PROTOCOL_VERSION; type: "done"; text: string }
  | {
      v: typeof PROTOCOL_VERSION
      type: "error"
      message: string
      code: string
    }
  | { v: typeof PROTOCOL_VERSION; type: "pong"; id: number }

export type CoreCommand =
  | { v: typeof PROTOCOL_VERSION; type: "start" }
  | { v: typeof PROTOCOL_VERSION; type: "stop" }
  | { v: typeof PROTOCOL_VERSION; type: "cancel" }
  | { v: typeof PROTOCOL_VERSION; type: "shutdown" }
  | { v: typeof PROTOCOL_VERSION; type: "ping"; id: number }

export function encodeCommand(command: CoreCommand): string {
  return JSON.stringify(command) + "\n"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parses one stdout line. Returns null for blank lines, non-JSON lines, and
 * unknown or malformed events. A version mismatch is returned as an error
 * event so the UI can explain it rather than silently doing nothing.
 */
export function parseEvent(line: string): CoreEvent | null {
  const text = line.trim()
  if (!text) return null

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.type !== "string") return null

  if (value.v !== PROTOCOL_VERSION) {
    return {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "protocol_mismatch",
      message: `voice-core speaks protocol ${String(value.v ?? "unknown")}; this plugin speaks ${PROTOCOL_VERSION}. Reinstall opencode-voice-phonon.`,
    }
  }

  switch (value.type) {
    case "hello":
      if (
        typeof value.version !== "string" ||
        typeof value.model !== "string" ||
        typeof value.platform !== "string"
      ) {
        return null
      }
      return {
        v: PROTOCOL_VERSION,
        type: "hello",
        version: value.version,
        model: value.model,
        platform: value.platform,
      }

    case "state":
      if (
        value.state !== "idle" &&
        value.state !== "preparing" &&
        value.state !== "listening" &&
        value.state !== "transcribing"
      ) {
        return null
      }
      return { v: PROTOCOL_VERSION, type: "state", state: value.state }

    case "model":
      if (
        value.state !== "downloading" &&
        value.state !== "extracting" &&
        value.state !== "loading" &&
        value.state !== "ready"
      ) {
        return null
      }
      return {
        v: PROTOCOL_VERSION,
        type: "model",
        state: value.state,
        received: typeof value.received === "number" ? value.received : undefined,
        total: typeof value.total === "number" ? value.total : undefined,
      }

    case "partial":
      return typeof value.text === "string"
        ? { v: PROTOCOL_VERSION, type: "partial", text: value.text }
        : null

    case "final":
      if (
        typeof value.text !== "string" ||
        typeof value.start !== "number" ||
        typeof value.end !== "number"
      ) {
        return null
      }
      return {
        v: PROTOCOL_VERSION,
        type: "final",
        text: value.text,
        start: value.start,
        end: value.end,
      }

    case "done":
      return typeof value.text === "string"
        ? { v: PROTOCOL_VERSION, type: "done", text: value.text }
        : null

    case "error":
      return typeof value.message === "string" && typeof value.code === "string"
        ? {
            v: PROTOCOL_VERSION,
            type: "error",
            message: value.message,
            code: value.code,
          }
        : null

    case "pong":
      return typeof value.id === "number"
        ? { v: PROTOCOL_VERSION, type: "pong", id: value.id }
        : null

    default:
      return null
  }
}

/** Human-readable one-line status used by the prompt footer. */
export function eventLabel(event: CoreEvent): string | undefined {
  switch (event.type) {
    case "state":
      switch (event.state) {
        case "preparing":
          return "preparing"
        case "listening":
          return "listening"
        case "transcribing":
          return "transcribing"
        default:
          return undefined
      }
    case "model":
      switch (event.state) {
        case "downloading":
          return event.total
            ? `model ${Math.floor((event.received ?? 0) / event.total * 100)}%`
            : "model"
        case "extracting":
          return "unpacking"
        case "loading":
          return "loading"
        case "ready":
          return undefined
      }
  }
  return undefined
}

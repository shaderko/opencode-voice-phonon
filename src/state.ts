/**
 * Pure voice UI state.
 *
 * One `VoiceState` lives in the TUI, and every backend event is folded into it
 * with `reduceVoice`. Nothing here touches the framework, the sidecar, or the
 * transcript history: no mutation, no effects, no imports beyond the protocol.
 */

import type { CoreEvent, ModelState } from "./protocol.ts"

export type VoiceStatus = "idle" | "preparing" | "listening" | "transcribing"

export interface VoiceModel {
  state: ModelState
  received?: number
  total?: number
}

export interface VoiceState {
  status: VoiceStatus
  partial: string
  model?: VoiceModel
  finals: string[]
  sessionID?: string
  error?: string
}

export const initialVoiceState: VoiceState = {
  status: "idle",
  partial: "",
  finals: [],
}

export type VoiceAction =
  | { type: "start"; sessionID: string }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "core"; event: CoreEvent }
  | { type: "clear-error" }

type OptionalKey = "model" | "sessionID" | "error"

/** Returns a copy without the named optional keys, preserving the rest. */
function omitOptional(state: VoiceState, ...keys: OptionalKey[]): VoiceState {
  const next: VoiceState = { ...state }
  for (const key of keys) {
    if (key === "model") delete next.model
    else if (key === "sessionID") delete next.sessionID
    else delete next.error
  }
  return next
}

function reduceCore(state: VoiceState, event: CoreEvent): VoiceState {
  switch (event.type) {
    // The greeting is informational; `model` and `state` follow it.
    case "hello":
      return state

    case "state": {
      if (event.state === "idle") {
        // Keep finals so the UI can still show and submit the last transcript.
        if (state.status === "idle" && state.partial === "" && state.model === undefined) {
          return state
        }
        return { ...omitOptional(state, "model"), status: "idle", partial: "" }
      }

      if (event.state === "listening") {
        if (state.status === "listening" && state.error === undefined) return state
        return { ...omitOptional(state, "error"), status: "listening" }
      }

      if (state.status === event.state) return state
      return { ...state, status: event.state }
    }

    case "model": {
      const model: VoiceModel = { state: event.state }
      if (event.received !== undefined) model.received = event.received
      if (event.total !== undefined) model.total = event.total
      // `ready` only means the model is available; the following
      // `state(listening)` is what moves the UI forward.
      const preparing = event.state !== "ready"
      return { ...state, model, status: preparing ? "preparing" : state.status }
    }

    case "partial":
      // Ignore stragglers that arrive outside an active recording.
      if (state.status !== "listening" || state.partial === event.text) return state
      return { ...state, partial: event.text }

    case "final": {
      const text = event.text
      if (!text && state.partial === "") return state
      return {
        ...state,
        finals: text ? [...state.finals, text] : state.finals,
        partial: "",
      }
    }

    case "done": {
      const finals = event.text ? [event.text] : state.finals
      if (finals === state.finals && state.status === "transcribing") return state
      return { ...state, finals, status: "transcribing" }
    }

    case "error":
      // The recording failed, so drop anything that could be submitted.
      return {
        ...omitOptional(state, "model"),
        status: "idle",
        partial: "",
        finals: [],
        error: event.message,
      }

    case "pong":
      return state
  }
}

export function reduceVoice(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "start":
      if (action.sessionID.trim() === "") return state
      return {
        status: "preparing",
        partial: "",
        finals: [],
        sessionID: action.sessionID,
      }

    case "stop":
      if (state.status !== "listening" && state.status !== "preparing") return state
      return { ...state, status: "transcribing" }

    case "cancel":
      return { status: "idle", partial: "", finals: [] }

    case "core":
      return reduceCore(state, action.event)

    case "clear-error":
      if (state.error === undefined) return state
      return omitOptional(state, "error")
  }
}

/** The text to show in the prompt: settled finals first, then the live partial. */
export function transcript(state: VoiceState): string {
  const settled = state.finals.join(" ").trim()
  if (settled) return settled
  return state.partial.trim()
}

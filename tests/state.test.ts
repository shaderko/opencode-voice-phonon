import { describe, expect, it } from "vitest"

import {
  initialVoiceState,
  reduceVoice,
  transcript,
  type VoiceState,
} from "../src/state.ts"

function started(sessionID = "session-1"): VoiceState {
  return reduceVoice(initialVoiceState, { type: "start", sessionID })
}

function listening(sessionID = "session-1"): VoiceState {
  return reduceVoice(started(sessionID), {
    type: "core",
    event: { v: 1, type: "state", state: "listening" },
  })
}

describe("reduceVoice start", () => {
  it("starts preparing with a session id and no leftover text", () => {
    const state = reduceVoice(
      { ...initialVoiceState, partial: "stale", finals: ["old"], error: "nope" },
      { type: "start", sessionID: "session-1" },
    )

    expect(state.status).toBe("preparing")
    expect(state.sessionID).toBe("session-1")
    expect(state.partial).toBe("")
    expect(state.finals).toEqual([])
    expect(state.error).toBeUndefined()
    expect(state.model).toBeUndefined()
  })

  it("ignores an empty session id", () => {
    expect(reduceVoice(initialVoiceState, { type: "start", sessionID: "" })).toBe(
      initialVoiceState,
    )
  })
})

describe("reduceVoice model events", () => {
  it("reports download progress while preparing", () => {
    const state = reduceVoice(started(), {
      type: "core",
      event: {
        v: 1,
        type: "model",
        state: "downloading",
        received: 512,
        total: 1024,
      },
    })

    expect(state.status).toBe("preparing")
    expect(state.model).toEqual({
      state: "downloading",
      received: 512,
      total: 1024,
    })
  })

  it("keeps the current status when the model becomes ready", () => {
    const state = reduceVoice(initialVoiceState, {
      type: "core",
      event: { v: 1, type: "model", state: "ready" },
    })

    expect(state.model?.state).toBe("ready")
    expect(state.status).toBe("idle")
  })
})

describe("reduceVoice listening and partials", () => {
  it("moves to listening on core state", () => {
    expect(listening().status).toBe("listening")
  })

  it("updates the partial only while listening", () => {
    const state = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "partial", text: "hello wor" },
    })

    expect(state.status).toBe("listening")
    expect(state.partial).toBe("hello wor")

    const ignored = reduceVoice(initialVoiceState, {
      type: "core",
      event: { v: 1, type: "partial", text: "too early" },
    })
    expect(ignored.partial).toBe("")
  })
})

describe("reduceVoice finals", () => {
  it("appends finalized segments and clears the partial", () => {
    let state = listening()
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "partial", text: "one" },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "final", text: "one", start: 0, end: 500 },
    })

    expect(state.finals).toEqual(["one"])
    expect(state.partial).toBe("")

    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "final", text: "two", start: 500, end: 900 },
    })

    expect(state.finals).toEqual(["one", "two"])
    expect(transcript(state)).toBe("one two")
  })

  it("does not append an empty final", () => {
    const state = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "final", text: "", start: 0, end: 0 },
    })

    expect(state.finals).toEqual([])
  })
})

describe("reduceVoice done", () => {
  it("replaces the finals with the done transcript", () => {
    let state = listening()
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "final", text: "half", start: 0, end: 200 },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "done", text: "final transcript" },
    })

    expect(state.status).toBe("transcribing")
    expect(state.finals).toEqual(["final transcript"])
    expect(transcript(state)).toBe("final transcript")
  })

  it("keeps existing finals when done carries no text", () => {
    let state = listening()
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "final", text: "kept", start: 0, end: 100 },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "done", text: "" },
    })

    expect(state.status).toBe("transcribing")
    expect(state.finals).toEqual(["kept"])
  })

  it("preserves finals when the core returns to idle", () => {
    let state = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "done", text: "hello world" },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "state", state: "idle" },
    })

    expect(state.status).toBe("idle")
    expect(state.partial).toBe("")
    expect(state.finals).toEqual(["hello world"])
    expect(transcript(state)).toBe("hello world")
  })
})

describe("reduceVoice errors", () => {
  it("goes idle, records the message, and drops partial results", () => {
    let state = reduceVoice(started(), {
      type: "core",
      event: { v: 1, type: "model", state: "downloading" },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "state", state: "listening" },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "partial", text: "unfinished" },
    })
    state = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "final", text: "partial garbage", start: 0, end: 10 },
    })

    const failed = reduceVoice(state, {
      type: "core",
      event: { v: 1, type: "error", message: "mic unavailable", code: "audio" },
    })

    expect(failed.status).toBe("idle")
    expect(failed.error).toBe("mic unavailable")
    expect(failed.partial).toBe("")
    expect(failed.finals).toEqual([])
    expect(failed.model).toBeUndefined()
    expect(transcript(failed)).toBe("")
  })

  it("clears an error on request and treats it as a no-op when absent", () => {
    const failed = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "error", message: "boom", code: "unknown" },
    })

    const cleared = reduceVoice(failed, { type: "clear-error" })
    expect(cleared.error).toBeUndefined()
    expect(reduceVoice(cleared, { type: "clear-error" })).toBe(cleared)
  })
})

describe("reduceVoice cancel and stop", () => {
  it("cancel returns to idle and clears everything", () => {
    let state = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "final", text: "draft", start: 0, end: 100 },
    })
    state = { ...state, error: "old" }

    const cancelled = reduceVoice(state, { type: "cancel" })

    expect(cancelled).toEqual({ status: "idle", partial: "", finals: [] })
    expect(cancelled.sessionID).toBeUndefined()
    expect(cancelled.model).toBeUndefined()
    expect(cancelled.error).toBeUndefined()
  })

  it("stop transcribes only from listening or preparing", () => {
    expect(reduceVoice(listening(), { type: "stop" }).status).toBe("transcribing")
    expect(reduceVoice(started(), { type: "stop" }).status).toBe("transcribing")

    const transcribing = reduceVoice(listening(), { type: "stop" })
    expect(reduceVoice(transcribing, { type: "stop" })).toBe(transcribing)
    expect(reduceVoice(initialVoiceState, { type: "stop" })).toBe(initialVoiceState)
  })
})

describe("transcript", () => {
  it("falls back to the trimmed partial when there are no finals", () => {
    const state: VoiceState = {
      status: "listening",
      partial: "  live words  ",
      finals: [],
    }

    expect(transcript(state)).toBe("live words")
    expect(transcript(initialVoiceState)).toBe("")
  })
})

describe("immutability", () => {
  it("does not mutate the input state or its arrays", () => {
    const base = reduceVoice(listening(), {
      type: "core",
      event: { v: 1, type: "final", text: "first", start: 0, end: 100 },
    })
    const finals = base.finals

    const next = reduceVoice(base, {
      type: "core",
      event: { v: 1, type: "final", text: "second", start: 100, end: 200 },
    })

    expect(base.finals).toBe(finals)
    expect(base.finals).toEqual(["first"])
    expect(next.finals).toEqual(["first", "second"])
    expect(next).not.toBe(base)
  })
})

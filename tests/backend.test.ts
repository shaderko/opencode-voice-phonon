import { describe, expect, it } from "vitest"

import { VoiceBackend, type BackendEvent } from "../src/backend.ts"

// A missing binary keeps every test child-process free: nothing is spawned
// until start(), and start() is never called here.

describe("VoiceBackend before start", () => {
  it("is not running immediately after construction", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    expect(backend.running).toBe(false)
  })

  it("refuses to send ping before start", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    expect(backend.send({ v: 1, type: "ping", id: 1 })).toBe(false)
  })

  it("refuses every command before start", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    expect(backend.send({ v: 1, type: "start" })).toBe(false)
    expect(backend.send({ v: 1, type: "stop" })).toBe(false)
    expect(backend.send({ v: 1, type: "cancel" })).toBe(false)
    expect(backend.send({ v: 1, type: "shutdown" })).toBe(false)
  })

  it("accepts options without starting", () => {
    const backend = new VoiceBackend({
      binary: "does-not-exist",
      modelDir: "/models/phonon",
      env: { OPENCODE_VOICE_DEBUG: "0" },
    })

    expect(backend.running).toBe(false)
    expect(backend.send({ v: 1, type: "ping", id: 2 })).toBe(false)
  })
})

describe("VoiceBackend onEvent", () => {
  it("returns an unsubscribe function", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    const unsubscribe = backend.onEvent(() => {})

    expect(typeof unsubscribe).toBe("function")
    expect(() => unsubscribe()).not.toThrow()
  })

  it("does not deliver events before start", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })
    const seen: BackendEvent[] = []

    const unsubscribe = backend.onEvent((event) => {
      seen.push(event)
    })
    unsubscribe()

    expect(seen).toEqual([])
  })

  it("tolerates unsubscribing twice and keeps other listeners registered", () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })
    const first: BackendEvent[] = []
    const second: BackendEvent[] = []

    const unsubscribeFirst = backend.onEvent((event) => {
      first.push(event)
    })
    const unsubscribeSecond = backend.onEvent((event) => {
      second.push(event)
    })

    unsubscribeFirst()
    unsubscribeSecond()

    expect(() => unsubscribeFirst()).not.toThrow()
    expect(() => unsubscribeSecond()).not.toThrow()
    expect(first).toEqual([])
    expect(second).toEqual([])
  })
})

describe("VoiceBackend dispose", () => {
  it("resolves on a never-started instance", async () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    await expect(backend.dispose()).resolves.toBeUndefined()
    expect(backend.running).toBe(false)
  })

  it("is idempotent on a never-started instance", async () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })

    await backend.dispose()

    await expect(backend.dispose()).resolves.toBeUndefined()
  })

  it("rejects commands after dispose", async () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })
    await backend.dispose()

    expect(backend.send({ v: 1, type: "ping", id: 3 })).toBe(false)
    expect(backend.send({ v: 1, type: "shutdown" })).toBe(false)
  })

  it("leaves listeners callable after dispose", async () => {
    const backend = new VoiceBackend({ binary: "does-not-exist" })
    const unsubscribe = backend.onEvent(() => {})
    await backend.dispose()

    expect(() => unsubscribe()).not.toThrow()
  })
})

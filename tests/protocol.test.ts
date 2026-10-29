import { describe, expect, it } from "vitest"

import {
  PROTOCOL_VERSION,
  encodeCommand,
  eventLabel,
  parseEvent,
  type CoreCommand,
  type CoreEvent,
} from "../src/protocol.ts"

const V = PROTOCOL_VERSION

describe("encodeCommand", () => {
  const commands: CoreCommand[] = [
    { v: V, type: "start" },
    { v: V, type: "stop" },
    { v: V, type: "cancel" },
    { v: V, type: "shutdown" },
    { v: V, type: "ping", id: 7 },
  ]

  it("ends with exactly one trailing newline", () => {
    for (const command of commands) {
      const line = encodeCommand(command)
      const parts = line.split("\n")

      expect(parts).toHaveLength(2)
      expect(parts[0]).not.toBe("")
      expect(parts[1]).toBe("")
    }
  })

  it("produces valid JSON that round-trips to the same command", () => {
    for (const command of commands) {
      const line = encodeCommand(command)

      expect(JSON.parse(line)).toEqual(command)
    }
  })

  it("matches the documented wire format exactly", () => {
    expect(encodeCommand({ v: 1, type: "start" })).toBe('{"v":1,"type":"start"}\n')
    expect(encodeCommand({ v: 1, type: "stop" })).toBe('{"v":1,"type":"stop"}\n')
    expect(encodeCommand({ v: 1, type: "cancel" })).toBe('{"v":1,"type":"cancel"}\n')
    expect(encodeCommand({ v: 1, type: "shutdown" })).toBe('{"v":1,"type":"shutdown"}\n')
    expect(encodeCommand({ v: 1, type: "ping", id: 42 })).toBe(
      '{"v":1,"type":"ping","id":42}\n',
    )
  })
})

describe("parseEvent documented events", () => {
  it("parses hello", () => {
    expect(
      parseEvent(
        '{"v":1,"type":"hello","version":"0.1.0","model":"phonon-2.5","platform":"win32-x64"}',
      ),
    ).toEqual({
      v: 1,
      type: "hello",
      version: "0.1.0",
      model: "phonon-2.5",
      platform: "win32-x64",
    })
  })

  it("parses every core state", () => {
    const states = ["idle", "preparing", "listening", "transcribing"] as const

    for (const state of states) {
      expect(parseEvent(JSON.stringify({ v: 1, type: "state", state }))).toEqual({
        v: 1,
        type: "state",
        state,
      })
    }
  })

  it("parses model downloading progress with a total", () => {
    expect(
      parseEvent(
        '{"v":1,"type":"model","state":"downloading","received":123,"total":183463606}',
      ),
    ).toEqual({
      v: 1,
      type: "model",
      state: "downloading",
      received: 123,
      total: 183463606,
    })
  })

  it("parses model downloading progress without a total", () => {
    expect(
      parseEvent('{"v":1,"type":"model","state":"downloading","received":123}'),
    ).toEqual({
      v: 1,
      type: "model",
      state: "downloading",
      received: 123,
      total: undefined,
    })
    expect(parseEvent('{"v":1,"type":"model","state":"downloading"}')).toEqual({
      v: 1,
      type: "model",
      state: "downloading",
      received: undefined,
      total: undefined,
    })
  })

  it("parses the remaining model states", () => {
    const states = ["extracting", "loading", "ready"] as const

    for (const state of states) {
      expect(parseEvent(JSON.stringify({ v: 1, type: "model", state }))).toEqual({
        v: 1,
        type: "model",
        state,
        received: undefined,
        total: undefined,
      })
    }
  })

  it("parses partial", () => {
    expect(parseEvent('{"v":1,"type":"partial","text":"hello wor"}')).toEqual({
      v: 1,
      type: "partial",
      text: "hello wor",
    })
  })

  it("parses final with numeric bounds", () => {
    expect(
      parseEvent('{"v":1,"type":"final","text":"Hello world.","start":0.0,"end":1.84}'),
    ).toEqual({
      v: 1,
      type: "final",
      text: "Hello world.",
      start: 0,
      end: 1.84,
    })
  })

  it("parses done", () => {
    expect(parseEvent('{"v":1,"type":"done","text":"Hello world."}')).toEqual({
      v: 1,
      type: "done",
      text: "Hello world.",
    })
  })

  it("parses error", () => {
    expect(
      parseEvent('{"v":1,"type":"error","message":"microphone denied","code":"permission"}'),
    ).toEqual({
      v: 1,
      type: "error",
      message: "microphone denied",
      code: "permission",
    })
  })

  it("parses pong", () => {
    expect(parseEvent('{"v":1,"type":"pong","id":17}')).toEqual({
      v: 1,
      type: "pong",
      id: 17,
    })
  })

  it("tolerates surrounding whitespace and CRLF", () => {
    expect(parseEvent('  {"v":1,"type":"done","text":"hi"}\r\n')).toEqual({
      v: 1,
      type: "done",
      text: "hi",
    })
  })
})

describe("parseEvent rejection", () => {
  it("returns null for blank lines", () => {
    expect(parseEvent("")).toBeNull()
    expect(parseEvent("   ")).toBeNull()
    expect(parseEvent("\t")).toBeNull()
    expect(parseEvent("\r\n")).toBeNull()
  })

  it("returns null for non-JSON input", () => {
    expect(parseEvent("hello there")).toBeNull()
    expect(parseEvent("{")).toBeNull()
    expect(parseEvent("undefined")).toBeNull()
  })

  it("returns null for JSON that is not an event object", () => {
    expect(parseEvent("null")).toBeNull()
    expect(parseEvent("[]")).toBeNull()
    expect(parseEvent('"hello"')).toBeNull()
    expect(parseEvent("42")).toBeNull()
  })

  it("returns null for unknown types", () => {
    expect(parseEvent('{"v":1,"type":"beep"}')).toBeNull()
    expect(parseEvent('{"v":1,"type":"State","state":"idle"}')).toBeNull()
  })

  it("returns null when a required field is missing or mistyped", () => {
    const lines = [
      // hello
      '{"v":1,"type":"hello","model":"phonon-2.5","platform":"win32-x64"}',
      '{"v":1,"type":"hello","version":"0.1.0","platform":"win32-x64"}',
      '{"v":1,"type":"hello","version":"0.1.0","model":"phonon-2.5"}',
      '{"v":1,"type":"hello","version":1,"model":"phonon-2.5","platform":"win32-x64"}',
      // state
      '{"v":1,"type":"state"}',
      '{"v":1,"type":"state","state":"paused"}',
      // model
      '{"v":1,"type":"model"}',
      '{"v":1,"type":"model","state":"downloaded"}',
      // partial
      '{"v":1,"type":"partial"}',
      '{"v":1,"type":"partial","text":7}',
      // final
      '{"v":1,"type":"final","text":"hi","start":0}',
      '{"v":1,"type":"final","text":"hi","end":1}',
      '{"v":1,"type":"final","start":0,"end":1}',
      '{"v":1,"type":"final","text":"hi","start":"0","end":1}',
      // done
      '{"v":1,"type":"done"}',
      // error
      '{"v":1,"type":"error","message":"oops"}',
      '{"v":1,"type":"error","code":"busy"}',
      // pong
      '{"v":1,"type":"pong"}',
      '{"v":1,"type":"pong","id":"1"}',
    ]

    for (const line of lines) {
      expect(parseEvent(line), line).toBeNull()
    }
  })

  it("turns a wrong version into a protocol_mismatch error event", () => {
    expect(
      parseEvent(
        '{"v":2,"type":"hello","version":"0.1.0","model":"phonon-2.5","platform":"win32-x64"}',
      ),
    ).toEqual({
      v: 1,
      type: "error",
      code: "protocol_mismatch",
      message:
        "voice-core speaks protocol 2; this plugin speaks 1. Reinstall opencode-voice-phonon.",
    })
  })

  it("turns a missing version into a protocol_mismatch error event", () => {
    const event = parseEvent('{"type":"pong","id":1}')

    expect(event?.type).toBe("error")
    if (event?.type !== "error") throw new Error("expected an error event")
    expect(event.code).toBe("protocol_mismatch")
    expect(event.message).toBe(
      "voice-core speaks protocol unknown; this plugin speaks 1. Reinstall opencode-voice-phonon.",
    )
  })

  it("checks the version before the type-specific shape", () => {
    const event = parseEvent('{"v":2,"type":"state","state":"paused"}')

    expect(event?.type).toBe("error")
    if (event?.type !== "error") throw new Error("expected an error event")
    expect(event.code).toBe("protocol_mismatch")
  })
})

describe("eventLabel", () => {
  it("labels preparing, listening and transcribing", () => {
    expect(eventLabel({ v: V, type: "state", state: "preparing" })).toBe("preparing")
    expect(eventLabel({ v: V, type: "state", state: "listening" })).toBe("listening")
    expect(eventLabel({ v: V, type: "state", state: "transcribing" })).toBe("transcribing")
  })

  it("no label for idle state", () => {
    expect(eventLabel({ v: V, type: "state", state: "idle" })).toBeUndefined()
  })

  it("labels model downloading with a percentage", () => {
    expect(
      eventLabel({
        v: V,
        type: "model",
        state: "downloading",
        received: 512,
        total: 1024,
      }),
    ).toBe("model 50%")
    expect(
      eventLabel({
        v: V,
        type: "model",
        state: "downloading",
        received: 0,
        total: 1024,
      }),
    ).toBe("model 0%")
    expect(
      eventLabel({
        v: V,
        type: "model",
        state: "downloading",
        received: 1023,
        total: 1024,
      }),
    ).toBe("model 99%")
    expect(
      eventLabel({
        v: V,
        type: "model",
        state: "downloading",
        received: 1024,
        total: 1024,
      }),
    ).toBe("model 100%")
  })

  it("labels model downloading without a total simply as model", () => {
    expect(eventLabel({ v: V, type: "model", state: "downloading" })).toBe("model")
    expect(
      eventLabel({ v: V, type: "model", state: "downloading", received: 5 }),
    ).toBe("model")
    expect(
      eventLabel({ v: V, type: "model", state: "downloading", received: 5, total: 0 }),
    ).toBe("model")
  })

  it("labels extracting and loading", () => {
    expect(eventLabel({ v: V, type: "model", state: "extracting" })).toBe("unpacking")
    expect(eventLabel({ v: V, type: "model", state: "loading" })).toBe("loading")
  })

  it("no label for ready or non-status events", () => {
    const events: CoreEvent[] = [
      { v: V, type: "model", state: "ready" },
      { v: V, type: "hello", version: "0.1.0", model: "phonon-2.5", platform: "linux-x64" },
      { v: V, type: "partial", text: "hi" },
      { v: V, type: "final", text: "hi", start: 0, end: 1 },
      { v: V, type: "done", text: "hi" },
      { v: V, type: "error", message: "oops", code: "engine" },
      { v: V, type: "pong", id: 1 },
    ]

    for (const event of events) {
      expect(eventLabel(event)).toBeUndefined()
    }
  })
})

import { describe, expect, it, vi } from "vitest"

const tokens = vi.hoisted(() => ({
  Command: { kind: "command" },
  ComposerPill: { kind: "composer-pill" },
  Style: { kind: "style" },
}))

vi.mock("@opencode/plugin/gui", () => ({
  Plugin: { define: (value: unknown) => value },
  Command: tokens.Command,
  ComposerPill: tokens.ComposerPill,
  Style: tokens.Style,
  Ipc: { define: (value: unknown) => value },
}))

const gui = (await import("../src/gui.tsx")).default

function composer() {
  const inserted: string[] = []
  let focused = false
  return {
    inserted,
    focused: () => focused,
    value: {
      insert(text: string) {
        inserted.push(text)
      },
      focus() {
        focused = true
      },
    },
  }
}

describe("desktop GUI", () => {
  it("provides the voice Ipc from the main process", () => {
    let provided: { token: { id: string }; value: Record<string, unknown> } | undefined
    const provider = { emit: vi.fn(), changed: vi.fn(), dispose: vi.fn() }
    const result = gui.main?.({
      options: {},
      provide(token: { id: string }, value: Record<string, unknown>) {
        provided = { token, value }
        return provider
      },
      log: { write: vi.fn() },
    } as never)

    expect(provided?.token.id).toBe("voice.phonon.voice")
    expect(Object.keys(provided?.value ?? {}).sort()).toEqual([
      "cancel",
      "start",
      "status",
      "stop",
    ])
    if (typeof result === "function") result()
  })

  it("registers the composer pill and command, then inserts the transcript", async () => {
    const listeners: Record<string, Array<(value: any) => void>> = {}
    const voice = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => ({ text: "hello from desktop" })),
      cancel: vi.fn(async () => true),
      status: vi.fn(async () => "idle"),
      state: () => undefined,
      on(name: string, listener: (value: any) => void) {
        ;(listeners[name] ??= []).push(listener)
        return () => {}
      },
    }
    const added: Array<{ token: unknown; item: any }> = []
    const c = composer()
    const toast = vi.fn()
    const session = { key: "server\nsession", id: "session" }
    const cleanup = gui.setup?.({
      options: {},
      main: () => voice,
      add(token: unknown, item: unknown) {
        added.push({ token, item })
        return () => {}
      },
      screen: { current: () => ({ composer: c.value }) },
      sessions: { current: () => session },
      toast: { show: toast },
    } as never)

    const pill = added.find((entry) => entry.token === tokens.ComposerPill)?.item
    expect(pill?.id).toBe("mic")
    expect(pill?.show({ session, screen: { composer: c.value } })?.icon).toBe("waveform")
    expect(pill?.show({ session, screen: { composer: c.value } })?.label).toBe("Voice")

    const style = added.find((entry) => entry.token === tokens.Style)?.item
    expect(style).toContain("left: 50%")
    expect(style).toContain("translateX(-50%)")

    const command = added
      .find((entry) => entry.token === tokens.Command)
      ?.item?.() as { id: string; bind: string; slash: { name: string }; run: () => void }
    expect(command.id).toBe("toggle")
    expect(command.bind).toBe("mod+shift+space")
    expect(command.slash.name).toBe("voice")

    command.run()
    expect(voice.start).toHaveBeenCalledOnce()
    listeners.state?.forEach((listener) => listener({ status: "listening" }))
    expect(pill?.show({ session, screen: { composer: c.value } })?.label).toBe("Listening")
    command.run()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(voice.stop).toHaveBeenCalledOnce()
    expect(c.inserted).toEqual(["hello from desktop "])
    expect(c.focused()).toBe(true)
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Voice", variant: "success" }),
    )
    cleanup?.()
  })
})

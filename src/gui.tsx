import { ComposerPill, Command, Plugin, Style, type Composer, type IpcProvider } from "@opencode/plugin/gui"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createSignal } from "solid-js"

import { VoiceBackend, type BackendEvent } from "./backend.ts"
import type { CoreState } from "./protocol.ts"
import { binaryPath, isSupported, platformKey } from "./platform.ts"
import { VoiceIpc } from "./gui-contract.ts"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shorten(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export default Plugin.define({
  setup(ctx) {
    const [status, setStatus] = createSignal<CoreState>("idle")
    const [partial, setPartial] = createSignal("")
    const [recordingSession, setRecordingSession] = createSignal<string | undefined>()
    let activeComposer: Composer | undefined
    const voice = ctx.main(VoiceIpc)

    const toast = (description: string, variant: "default" | "success" | "error" = "default") =>
      ctx.toast.show({ title: "Voice", description, variant })

    voice.on("state", (event) => {
      setStatus(event.status)
      if (event.status === "idle") {
        setRecordingSession(undefined)
        activeComposer = undefined
      }
    })
    voice.on("partial", (event) => setPartial(event.text))
    voice.on("error", (event) => {
      setStatus("idle")
      setRecordingSession(undefined)
      activeComposer = undefined
      toast(event.message, "error")
    })

    async function toggle(composer: Composer, sessionKey: string): Promise<void> {
      const current = status()

      if (current === "listening") {
        setStatus("transcribing")
        const target = activeComposer ?? composer
        try {
          const { text } = await voice.stop()
          const cleaned = text.trim()
          if (!cleaned) {
            toast("No speech detected")
            return
          }
          target.insert(`${cleaned} `)
          target.focus()
          toast("Voice prompt inserted", "success")
        } catch (error) {
          toast(errorMessage(error), "error")
        } finally {
          setStatus("idle")
          setPartial("")
          setRecordingSession(undefined)
          activeComposer = undefined
        }
        return
      }

      if (current === "preparing" || current === "transcribing") {
        toast(current === "preparing" ? "Voice is still preparing" : "Voice is still transcribing")
        return
      }

      try {
        activeComposer = composer
        setRecordingSession(sessionKey)
        const started = await voice.start()
        if (!started) {
          toast("voice-core is not available", "error")
          setRecordingSession(undefined)
          activeComposer = undefined
          return
        }
        setStatus("preparing")
        setPartial("")
      } catch (error) {
        toast(errorMessage(error), "error")
        setStatus("idle")
        setRecordingSession(undefined)
        activeComposer = undefined
      }
    }

    function label(): string {
      switch (status()) {
        case "listening":
          return partial() ? `Listening: ${shorten(partial())}` : "Listening"
        case "preparing":
          return "Preparing voice"
        case "transcribing":
          return "Transcribing"
        default:
          return "Voice"
      }
    }

    function tone(): "warning" | "danger" | undefined {
      switch (status()) {
        case "listening":
          return "danger"
        case "preparing":
        case "transcribing":
          return "warning"
        default:
          return undefined
      }
    }

    ctx.add(ComposerPill, {
      id: "mic",
      order: -10,
      show: (input) => {
        const recording = recordingSession()
        if (recording && input.session.key !== recording) return undefined
        return {
          icon: "waveform",
          label: label(),
          title: "Voice prompt",
          tone: tone(),
          run: () => void toggle(input.screen.composer, input.session.key),
        }
      },
    })

    // OpenCode places plugin pills in the composer lane. The lane itself follows
    // the Background activity setting; this keeps the voice pill centered above
    // the composer regardless of that global preference, using the host's own
    // capsule markup and theme tokens.
    ctx.add(
      Style,
      `
[data-component="session-plugin-pills"]:has([data-slot="session-plugin-pill"][aria-label="Voice prompt"]) {
  position: absolute !important;
  left: 50% !important;
  bottom: 0.625rem !important;
  transform: translateX(-50%) !important;
}
      `,
    )

    ctx.add(Command, () => ({
      id: "toggle",
      title: "Voice: Dictate prompt",
      group: "Voice",
      bind: "mod+shift+space",
      slash: { name: "voice" },
      run: () => {
        const session = ctx.sessions.current()
        const composer = ctx.screen.current()?.composer
        if (!session || !composer) {
          toast("Open a session first")
          return
        }
        void toggle(composer, session.key)
      },
    }))
  },

  main(ctx) {
    let backend: VoiceBackend | undefined
    let lastState: CoreState = "idle"
    let provider: IpcProvider<typeof VoiceIpc.spec> | undefined
    let resolveStop: ((value: { text: string }) => void) | undefined
    let rejectStop: ((error: unknown) => void) | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let binaryPromise: Promise<string> | undefined

    /**
     * The Desktop host evaluates this bundle with `new Function`, so `__filename`
     * and `import.meta.url` are unavailable in main. Ask the local server which
     * directory the plugin was loaded from, then fall back to the global config
     * location used by `opencode plugin add`.
     */
    function resolveBinary(): Promise<string> {
      binaryPromise ??= (async () => {
        const explicit = process.env.OPENCODE_VOICE_BIN
        if (explicit) {
          if (!existsSync(explicit)) {
            throw new Error(`OPENCODE_VOICE_BIN points to a missing file: ${explicit}`)
          }
          return explicit
        }

        const key = platformKey()
        if (!isSupported(key)) {
          throw new Error(`voice-core is not packaged for ${key}`)
        }

        const roots: string[] = []
        try {
          const inventory = await ctx.client.plugin.list()
          const self = inventory.data.find((plugin) => plugin.id === "voice.phonon")
          if (self?.source.type === "local") roots.push(self.source.path)
        } catch {
          // The inventory call is an optimization; the config path below is the fallback.
        }

        const home = process.env.USERPROFILE ?? process.env.HOME
        if (home) roots.push(join(home, ".config", "opencode", "node_modules", "opencode-voice-phonon"))

        for (const root of roots) {
          const candidate = binaryPath(root, key)
          if (existsSync(candidate)) return candidate
        }

        throw new Error(
          `voice-core is not packaged for ${key}. Set OPENCODE_VOICE_BIN to the executable path.`,
        )
      })()
      return binaryPromise
    }

    function settleStop(text?: string, error?: unknown): void {
      if (stopTimer) {
        clearTimeout(stopTimer)
        stopTimer = undefined
      }
      if (error !== undefined) {
        const reject = rejectStop
        resolveStop = undefined
        rejectStop = undefined
        reject?.(error)
        return
      }
      const resolve = resolveStop
      resolveStop = undefined
      rejectStop = undefined
      resolve?.({ text: text ?? "" })
    }

    function handle(event: BackendEvent): void {
      if (event.type === "core") {
        const core = event.event
        if (core.type === "state") {
          lastState = core.state
          provider?.emit("state", { status: core.state })
        } else if (core.type === "partial") {
          provider?.emit("partial", { text: core.text })
        } else if (core.type === "done") {
          provider?.emit("done", { text: core.text })
          settleStop(core.text)
        } else if (core.type === "error") {
          provider?.emit("error", { message: core.message })
          settleStop(undefined, new Error(core.message))
        }
        return
      }

      if (event.type === "spawn_error") {
        provider?.emit("error", { message: event.message })
        settleStop(undefined, new Error(event.message))
        backend = undefined
        return
      }

      if (!event.stderr.length) {
        provider?.emit("error", { message: "voice-core exited" })
      } else {
        provider?.emit("error", { message: event.stderr[event.stderr.length - 1] })
      }
      settleStop(undefined, new Error("voice-core exited"))
      backend = undefined
    }

    async function ensureBackend(): Promise<VoiceBackend | undefined> {
      if (backend?.running) return backend

      const binary = await resolveBinary()
      const created = new VoiceBackend({
        binary,
        ...(typeof ctx.options.modelDir === "string" && ctx.options.modelDir
          ? { modelDir: ctx.options.modelDir }
          : {}),
      })
      created.onEvent(handle)
      backend = created
      try {
        created.start()
      } catch (error) {
        backend = undefined
        provider?.emit("error", { message: errorMessage(error) })
        return undefined
      }
      if (!created.running) {
        backend = undefined
        return undefined
      }
      return created
    }

    provider = ctx.provide(VoiceIpc, {
      start: async () => {
        const active = await ensureBackend()
        if (!active) return false
        return active.send({ v: 1, type: "start" })
      },
      stop: () => {
        const active = backend
        if (!active || !active.running) return { text: "" }
        if (!active.send({ v: 1, type: "stop" })) {
          throw new Error("voice-core is not running")
        }
        return new Promise<{ text: string }>((resolve, reject) => {
          resolveStop = resolve
          rejectStop = reject
          stopTimer = setTimeout(() => {
            stopTimer = undefined
            settleStop(undefined, new Error("voice-core did not finish in time"))
          }, 120_000)
        })
      },
      cancel: () => {
        const active = backend
        if (!active || !active.running) return false
        return active.send({ v: 1, type: "cancel" })
      },
      status: () => lastState,
    })

    return () => {
      provider?.dispose()
      settleStop(undefined, new Error("voice plugin stopped"))
      void backend?.dispose()
      backend = undefined
    }
  },
})

/** @jsxImportSource @opentui/solid */
/**
 * OpenCode TUI entry point.
 *
 * Renders the microphone affordance in the prompt footer, owns the one
 * `VoiceBackend` instance, and folds its events into a `VoiceState`. The
 * transcript is submitted to the session that was active when recording
 * started, even if the user navigated away in the meantime.
 */

import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"

import { VoiceBackend, type BackendEvent } from "./backend.ts"
import { resolveOptions } from "./config.ts"
import { PROTOCOL_VERSION } from "./protocol.ts"
import {
  initialVoiceState,
  reduceVoice,
  transcript,
  type VoiceState,
} from "./state.ts"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampPartial(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
}

export default Plugin.define({
  id: "voice.phonon.tui",
  setup(context) {
    const options = resolveOptions(context.options)
    const [state, setState] = createSignal<VoiceState>(initialVoiceState)

    let backend: VoiceBackend | undefined
    let activeSessionID: string | undefined
    let doneHandled = false
    let disposing = false

    function toast(
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
    ): void {
      context.ui.toast.show({ title: "Voice", message, variant })
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    function reset(): void {
      setState((prev) => reduceVoice(prev, { type: "cancel" }))
      doneHandled = false
      activeSessionID = undefined
    }

    function ensureBackend(): VoiceBackend | undefined {
      if (backend && backend.running) return backend

      const created = new VoiceBackend(
        options.modelDir ? { modelDir: options.modelDir } : {},
      )
      created.onEvent(handleBackend)
      backend = created

      try {
        created.start()
      } catch (error) {
        backend = undefined
        toast(`Could not start voice-core: ${errorMessage(error)}`, "error")
        return undefined
      }

      // A synchronous spawn_error clears `backend`, so only return a live one.
      return backend
    }

    async function submit(text: string, sessionID: string): Promise<void> {
      try {
        await context.client.session.prompt({ sessionID, text })
        toast("Voice prompt submitted", "success")
      } catch (error) {
        toast(`Could not submit prompt: ${errorMessage(error)}`, "error")
      }
    }

    function finish(text: string, sessionID: string | undefined): void {
      if (doneHandled) return
      doneHandled = true

      const cleaned = text.trim() || transcript(state()).trim()
      if (!cleaned) {
        toast("No speech detected", "warning")
        return
      }
      if (!sessionID) {
        toast("No active session to submit to", "warning")
        return
      }

      if (!options.review) {
        void submit(cleaned, sessionID)
        return
      }

      void (async () => {
        let edited: string | undefined
        try {
          edited = await context.ui.dialog.prompt({
            title: "Review voice prompt",
            description: "Edit the transcript before sending it.",
            value: cleaned,
          })
        } catch (error) {
          toast(`Could not open review: ${errorMessage(error)}`, "error")
          return
        }
        if (edited === undefined) return

        const finalText = edited.trim()
        if (!finalText) {
          toast("Nothing to submit", "warning")
          return
        }
        await submit(finalText, sessionID)
      })()
    }

    function handleBackend(event: BackendEvent): void {
      if (event.type === "core") {
        setState((prev) =>
          reduceVoice(prev, { type: "core", event: event.event }),
        )
        if (event.event.type === "done") {
          finish(event.event.text, activeSessionID)
        } else if (event.event.type === "error") {
          toast(event.event.message, "error")
        }
        return
      }

      if (event.type === "spawn_error") {
        toast(event.message, "error")
        reset()
        backend = undefined
        return
      }

      if (!disposing) {
        const reason =
          event.code !== null
            ? `code ${event.code}`
            : event.signal
              ? `signal ${event.signal}`
              : "unknown reason"
        toast(`voice-core exited (${reason})`, "error")
      }
      reset()
      backend = undefined
    }

    function toggle(sessionID?: string): void {
      const status = state().status

      if (status === "listening") {
        const active = backend
        if (!active || !active.send({ v: PROTOCOL_VERSION, type: "stop" })) {
          toast("voice-core is not running", "error")
          reset()
          return
        }
        setState((prev) => reduceVoice(prev, { type: "stop" }))
        return
      }

      if (status === "preparing" || status === "transcribing") {
        toast(
          status === "preparing"
            ? "Voice is still preparing the model"
            : "Voice is still transcribing",
          "info",
        )
        return
      }

      const target = sessionID ?? currentSessionID()
      if (!target) {
        toast("Open a session first", "warning")
        return
      }

      activeSessionID = target
      doneHandled = false
      setState((prev) => reduceVoice(prev, { type: "start", sessionID: target }))

      const active = ensureBackend()
      if (!active) {
        reset()
        return
      }

      if (!active.send({ v: PROTOCOL_VERSION, type: "start" })) {
        toast("voice-core is not running", "error")
        reset()
      }
    }

    function Mic(props: { sessionID?: string; showDetails: boolean }) {
      const icon = (): string => {
        switch (state().status) {
          case "listening":
            return "●"
          case "preparing":
          case "transcribing":
            return "◌"
          default:
            return "◉"
        }
      }

      const color = () => {
        switch (state().status) {
          case "listening":
            return context.theme.text.feedback.error.base
          case "preparing":
          case "transcribing":
            return context.theme.text.feedback.warning.base
          default:
            return context.theme.text.muted
        }
      }

      const label = (): string | undefined => {
        const current = state()
        switch (current.status) {
          case "listening":
            return "listening"
          case "transcribing":
            return "transcribing"
          case "preparing": {
            const model = current.model
            if (model?.total && model.received !== undefined) {
              const percent = Math.floor((model.received / model.total) * 100)
              return `model ${percent}%`
            }
            return "preparing"
          }
          default:
            return undefined
        }
      }

      return (
        <Show when={props.sessionID}>
          <box
            flexDirection="row"
            onMouseDown={() => toggle(props.sessionID)}
          >
            <text fg={color()}>{icon()}</text>
            <text fg={context.theme.text.muted}> voice</text>
            <Show when={label()}>
              <text fg={color()}> {label() ?? ""}</text>
            </Show>
            <Show
              when={
                props.showDetails &&
                options.showPartial &&
                state().partial.length > 0 &&
                state().partial
              }
            >
              <text fg={context.theme.text.muted}>
                {" "}
                {clampPartial(state().partial)}
              </text>
            </Show>
          </box>
        </Show>
      )
    }

    context.ui.slot({
      append: "prompt.footer",
      render: (input) => (
        <Mic sessionID={input.sessionID} showDetails={input.showDetails} />
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "voice.phonon.toggle",
          title: "Voice: Dictate prompt",
          group: "Voice",
          bind: options.keybind,
          palette: true,
          slash: { name: "voice" },
          run: () => {
            toggle(currentSessionID())
          },
        },
      ],
    }))

    return () => {
      disposing = true
      const active = backend
      backend = undefined
      if (active) void active.dispose()
    }
  },
})

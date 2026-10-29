import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/**
 * The Desktop GUI bridge between a window and the Electron main process.
 *
 * The window cannot spawn processes; main owns the one `VoiceBackend`
 * sidecar, streams its events to the window, and answers start/stop calls.
 */
export const VoiceIpc = Ipc.define({
  id: "voice.phonon.voice",
  events: {
    state: Schema.Struct({
      status: Schema.Literals(["idle", "preparing", "listening", "transcribing"]),
    }),
    partial: Schema.Struct({ text: Schema.String }),
    done: Schema.Struct({ text: Schema.String }),
    error: Schema.Struct({ message: Schema.String }),
  },
  methods: {
    start: { output: Schema.Boolean },
    stop: { output: Schema.Struct({ text: Schema.String }) },
    cancel: { output: Schema.Boolean },
    status: { output: Schema.String },
  },
})

export type VoiceIpc = typeof VoiceIpc

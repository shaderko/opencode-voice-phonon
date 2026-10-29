import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "voice.phonon",
  setup() {
    // TUI part owns the microphone and model lifecycle for now.
  },
})

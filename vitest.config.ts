import { defineConfig } from "vitest/config"

// The GUI logic tests run in Node with mocked Desktop APIs; no DOM is needed.
// Keeping this config separate also stops Vitest from applying the GUI Vite
// preset (which is only for the Desktop bundle).
export default defineConfig({
  test: {
    environment: "node",
  },
})

/**
 * Long-lived voice-core child process.
 *
 * Spawns `voice-core stream`, speaks JSONL commands over stdin, parses JSONL
 * events from stdout, and keeps the tail of stderr for diagnostics.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface, type Interface } from "node:readline"

import {
  PROTOCOL_VERSION,
  encodeCommand,
  parseEvent,
  type CoreCommand,
  type CoreEvent,
} from "./protocol.ts"
import { resolveBinaryPath } from "./platform.ts"

export type BackendEvent =
  | { type: "core"; event: CoreEvent }
  | {
      type: "exit"
      code: number | null
      signal: NodeJS.Signals | null
      stderr: string[]
    }
  | { type: "spawn_error"; message: string; stderr: string[] }

export interface VoiceBackendOptions {
  binary?: string
  modelDir?: string
  env?: NodeJS.ProcessEnv
}

const STDERR_RING_SIZE = 40
const DISPOSE_TIMEOUT_MS = 1500

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class VoiceBackend {
  private readonly options: VoiceBackendOptions
  private readonly debug: boolean

  private child: ChildProcessWithoutNullStreams | null = null
  private listeners = new Set<(event: BackendEvent) => void>()
  private stderrRing: string[] = []
  private stdoutReader: Interface | null = null
  private stderrReader: Interface | null = null
  private disposed = false
  private exitEmitted = false

  constructor(options: VoiceBackendOptions = {}) {
    this.options = options
    this.debug =
      (options.env?.OPENCODE_VOICE_DEBUG ?? process.env.OPENCODE_VOICE_DEBUG) === "1"
  }

  get running(): boolean {
    return (
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
  }

  /** Starts the sidecar. Idempotent while a child is alive. */
  start(): void {
    if (this.disposed || this.child) return

    let binary: string
    try {
      binary = this.options.binary ?? resolveBinaryPath()
    } catch (error) {
      this.emit({
        type: "spawn_error",
        message: errorMessage(error),
        stderr: [...this.stderrRing],
      })
      return
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env }
    if (this.options.modelDir) {
      env.OPENCODE_VOICE_MODEL_DIR = this.options.modelDir
    }

    this.stderrRing = []
    this.exitEmitted = false

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binary, ["stream"], {
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      })
    } catch (error) {
      this.emit({
        type: "spawn_error",
        message: errorMessage(error),
        stderr: [...this.stderrRing],
      })
      return
    }

    this.child = child

    // A failed write after EPIPE must not crash the TUI; send() reports the
    // failure to the caller instead.
    child.stdin.on("error", () => {})
    child.stdout.on("error", () => {})
    child.stderr.on("error", () => {})

    this.stdoutReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })
    this.stdoutReader.on("line", (line) => {
      const event = parseEvent(line)
      if (event) this.emit({ type: "core", event })
    })

    this.stderrReader = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    })
    this.stderrReader.on("line", (line) => {
      this.stderrRing.push(line)
      if (this.stderrRing.length > STDERR_RING_SIZE) {
        this.stderrRing.splice(0, this.stderrRing.length - STDERR_RING_SIZE)
      }
      if (this.debug) process.stderr.write(`${line}\n`)
    })

    child.on("error", (error) => {
      if (this.child === child) this.child = null
      this.closeReaders()
      this.emit({
        type: "spawn_error",
        message: error.message,
        stderr: [...this.stderrRing],
      })
    })

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null
      this.closeReaders()
      if (this.exitEmitted) return
      this.exitEmitted = true
      this.emit({
        type: "exit",
        code,
        signal,
        stderr: [...this.stderrRing],
      })
    })
  }

  /** Sends one command. Returns false when the sidecar cannot accept it. */
  send(command: CoreCommand): boolean {
    const child = this.child
    if (this.disposed || !child || !this.running) return false
    if (!child.stdin.writable || child.stdin.destroyed) return false
    try {
      child.stdin.write(encodeCommand(command))
      return true
    } catch {
      return false
    }
  }

  /** Subscribe to backend events. Returns an unsubscribe function. */
  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Shut the sidecar down, escalating to kill after the grace period. */
  async dispose(): Promise<void> {
    if (this.disposed) return

    const child = this.child
    if (!child || !this.running) {
      this.disposed = true
      this.child = null
      this.closeReaders()
      return
    }

    this.send({ v: PROTOCOL_VERSION, type: "shutdown" })
    this.disposed = true

    const exited = await new Promise<boolean>((resolveExit) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener("exit", onExit)
        resolveExit(value)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), DISPOSE_TIMEOUT_MS)
      child.once("exit", onExit)
    })

    if (!exited) {
      try {
        child.kill()
      } catch {
        // The process may already be gone.
      }
    }

    if (this.child === child) this.child = null
    this.closeReaders()

    // Drop every handler so a late exit cannot report after disposal.
    child.removeAllListeners()
    child.stdin.removeAllListeners()
    child.stdout.removeAllListeners()
    child.stderr.removeAllListeners()
  }

  private emit(event: BackendEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken listener must not stop event delivery to the others.
      }
    }
  }

  private closeReaders(): void {
    if (this.stdoutReader) {
      this.stdoutReader.close()
      this.stdoutReader = null
    }
    if (this.stderrReader) {
      this.stderrReader.close()
      this.stderrReader = null
    }
  }
}

import fs from "node:fs/promises"

export interface ShutdownHook {
  readonly name?: string
  readonly run: () => Promise<void> | void
  readonly priority?: number
}

export interface ShutdownOptions {
  readonly timeoutMs?: number
  readonly onExit?: (code: number) => void
  readonly autoExit?: boolean
  readonly logger?: {
    info?: (message: string, ...args: unknown[]) => void
    warn?: (message: string, ...args: unknown[]) => void
    error?: (message: string, ...args: unknown[]) => void
  }
}

export interface ShutdownSummary {
  readonly ok: boolean
  readonly timedOut: boolean
  readonly exitCode: number
  readonly signal?: string
  readonly executedHooks: number
  readonly failedHooks: number
  readonly pidFilesRemoved: number
  readonly locksReleased: number
  readonly errors: ReadonlyArray<{ name: string; error: unknown }>
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

export class GracefulShutdownCoordinator {
  private readonly timeoutMs: number
  private readonly onExit: (code: number) => void
  private readonly autoExit: boolean
  private readonly logger: ShutdownOptions["logger"]

  private hooks: Array<{ id: number; name: string; run: () => Promise<void> | void; priority: number }> = []
  private hookCounter = 0
  private pidFiles = new Set<string>()
  private lockReleases = new Set<() => Promise<void> | void>()
  private registeredListeners: Array<{ emitter: NodeJS.EventEmitter; signal: NodeJS.Signals; listener: () => void }> = []

  private isShuttingDown = false
  private shutdownPromise: Promise<ShutdownSummary> | null = null

  constructor(options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.onExit = options.onExit ?? ((code) => process.exit(code))
    this.autoExit = options.autoExit ?? true
    this.logger = options.logger
  }

  addHook(hook: ShutdownHook | (() => Promise<void> | void)): () => void {
    const id = ++this.hookCounter
    const normalized: { id: number; name: string; run: () => Promise<void> | void; priority: number } =
      typeof hook === "function"
        ? { id, name: `hook-${id}`, run: hook, priority: 0 }
        : { id, name: hook.name ?? `hook-${id}`, run: hook.run, priority: hook.priority ?? 0 }

    this.hooks.push(normalized)

    return () => {
      this.hooks = this.hooks.filter((h) => h.id !== id)
    }
  }

  registerPidFile(filePath: string): () => void {
    this.pidFiles.add(filePath)
    return () => {
      this.pidFiles.delete(filePath)
    }
  }

  registerLock(release: () => Promise<void> | void): () => void {
    this.lockReleases.add(release)
    return () => {
      this.lockReleases.delete(release)
    }
  }

  listen(
    signals: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM"],
    emitter: NodeJS.EventEmitter = process,
  ): void {
    for (const signal of signals) {
      const listener = () => {
        if (this.isShuttingDown) {
          this.logger?.warn?.(`Received second ${signal} during graceful shutdown; forcing immediate exit`)
          this.onExit(1)
          return
        }
        void this.shutdown(signal)
      }

      emitter.on(signal, listener)
      this.registeredListeners.push({ emitter, signal, listener })
    }
  }

  unlisten(emitter?: NodeJS.EventEmitter): void {
    this.registeredListeners = this.registeredListeners.filter((entry) => {
      if (!emitter || entry.emitter === emitter) {
        entry.emitter.off(entry.signal, entry.listener)
        return false
      }
      return true
    })
  }

  isShutdownInProgress(): boolean {
    return this.isShuttingDown
  }

  async shutdown(signal?: string, exitCode = 0): Promise<ShutdownSummary> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }

    this.isShuttingDown = true
    this.logger?.info?.(`Initiating graceful shutdown${signal ? ` due to ${signal}` : ""}...`)

    this.shutdownPromise = this.performShutdown(signal, exitCode)
    return this.shutdownPromise
  }

  private async performShutdown(signal?: string, exitCode = 0): Promise<ShutdownSummary> {
    let timedOut = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        this.logger?.warn?.(`Graceful shutdown timed out after ${this.timeoutMs}ms`)
        resolve({ isTimeout: true })
      }, this.timeoutMs)
    })

    const executionPromise = (async () => {
      const errors: Array<{ name: string; error: unknown }> = []
      let executedHooks = 0

      // Sort hooks by priority descending (higher numbers first)
      const sortedHooks = [...this.hooks].sort((a, b) => b.priority - a.priority)

      for (const hook of sortedHooks) {
        if (timedOut) break
        try {
          await hook.run()
          executedHooks++
        } catch (error) {
          errors.push({ name: hook.name, error })
          this.logger?.error?.(`Shutdown hook "${hook.name}" failed:`, error)
        }
      }

      // Guarantee PID files removal
      let pidFilesRemoved = 0
      for (const pidFile of this.pidFiles) {
        try {
          await fs.rm(pidFile, { force: true })
          pidFilesRemoved++
        } catch (error) {
          errors.push({ name: `remove-pid:${pidFile}`, error })
          this.logger?.error?.(`Failed to remove PID file ${pidFile}:`, error)
        }
      }

      // Guarantee locks release
      let locksReleased = 0
      for (const release of this.lockReleases) {
        try {
          await release()
          locksReleased++
        } catch (error) {
          errors.push({ name: "release-lock", error })
          this.logger?.error?.("Failed to release lock:", error)
        }
      }

      return {
        isTimeout: false as const,
        executedHooks,
        failedHooks: errors.length,
        pidFilesRemoved,
        locksReleased,
        errors,
      }
    })()

    const outcome = await Promise.race([executionPromise, timeoutPromise])

    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
    }

    const summary: ShutdownSummary =
      outcome.isTimeout || timedOut
        ? {
            ok: false,
            timedOut: true,
            exitCode: exitCode !== 0 ? exitCode : 1,
            signal,
            executedHooks: 0,
            failedHooks: 0,
            pidFilesRemoved: 0,
            locksReleased: 0,
            errors: [{ name: "timeout", error: new Error(`Shutdown timed out after ${this.timeoutMs}ms`) }],
          }
        : {
            ok: outcome.errors.length === 0,
            timedOut: false,
            exitCode,
            signal,
            executedHooks: outcome.executedHooks,
            failedHooks: outcome.failedHooks,
            pidFilesRemoved: outcome.pidFilesRemoved,
            locksReleased: outcome.locksReleased,
            errors: outcome.errors,
          }

    if (this.autoExit) {
      this.onExit(summary.exitCode)
    }

    return summary
  }
}

export const shutdownCoordinator = new GracefulShutdownCoordinator()

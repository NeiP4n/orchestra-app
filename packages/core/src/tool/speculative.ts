import { Hash } from "@orchestra/util/hash"
import { Effect, Fiber } from "effect"

export const BUILTIN_READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "status",
  "inspect",
  "view",
  "list",
  "symbols",
])

export const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "shell",
  "delete",
  "rm",
  "kill",
  "exec",
  "terminal",
  "bash",
  "powershell",
])

export class SpeculativeSecurityError extends Error {
  readonly _tag = "SpeculativeSecurityError"
  constructor(readonly toolId: string, message?: string) {
    super(message ?? `Speculative execution of mutating tool "${toolId}" is forbidden for safety.`)
    this.name = "SpeculativeSecurityError"
  }
}

export function isReadOnlyTool(toolId: string, options?: { readOnlyHint?: boolean }): boolean {
  const normalized = toolId.toLowerCase().trim()
  if (MUTATING_TOOLS.has(normalized)) return false
  if (options?.readOnlyHint === true) return true
  if (options?.readOnlyHint === false) return false
  if (BUILTIN_READ_ONLY_TOOLS.has(normalized)) return true

  if (
    normalized.startsWith("read_") ||
    normalized.startsWith("search_") ||
    normalized.startsWith("get_") ||
    normalized.startsWith("list_") ||
    normalized.startsWith("inspect_")
  ) {
    return true
  }

  return false
}

export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJsonStringify).join(",") + "]"
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((obj as Record<string, unknown>)[k]))
  return "{" + entries.join(",") + "}"
}

export function hashArgs(args: unknown): string {
  return Hash.fast(canonicalJsonStringify(args))
}

export type SpeculativeStatus = "pending" | "completed" | "failed" | "discarded"

export type SpeculativeEntry<T = unknown> = {
  readonly sessionId: string
  readonly toolId: string
  readonly argsHash: string
  readonly key: string
  status: SpeculativeStatus
  readonly startedAt: number
  completedAt?: number
  result?: T
  error?: unknown
  fiber?: Fiber.Fiber<T, unknown>
  readonly abortController: AbortController
  readonly promise: Promise<T>
}

export type SpeculativeCommitResult<T> = {
  readonly hit: boolean
  readonly status: "completed" | "miss" | "failed" | "discarded"
  readonly value?: T
  readonly error?: unknown
  readonly elapsedMs: number
  readonly savedMs?: number
}

export type SpeculativeStats = {
  hits: number
  misses: number
  speculations: number
  active: number
  discarded: number
  discards: number
  savedMs: number
}

export class SpeculativeToolRunner {
  private entries = new Map<string, SpeculativeEntry<any>>()
  private stats: SpeculativeStats = {
    hits: 0,
    misses: 0,
    speculations: 0,
    active: 0,
    discarded: 0,
    discards: 0,
    savedMs: 0,
  }

  isReadOnly(toolId: string, options?: { readOnlyHint?: boolean }): boolean {
    return isReadOnlyTool(toolId, options)
  }

  speculate<T>(
    sessionId: string,
    toolId: string,
    args: unknown,
    runnerFn: (signal: AbortSignal) => Promise<T> | Effect.Effect<T, any>,
    options?: { readOnlyHint?: boolean },
  ): SpeculativeEntry<T> {
    if (!this.isReadOnly(toolId, options)) {
      throw new SpeculativeSecurityError(toolId)
    }

    const argsDigest = hashArgs(args)
    const key = `${sessionId}:${toolId}:${argsDigest}`

    const existing = this.entries.get(key)
    if (existing && (existing.status === "pending" || existing.status === "completed")) {
      return existing
    }

    const abortController = new AbortController()
    const startedAt = performance.now()
    this.stats.speculations++
    this.stats.active++

    let resolvePromise!: (val: T) => void
    let rejectPromise!: (err: unknown) => void

    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const entry: SpeculativeEntry<T> = {
      sessionId,
      toolId,
      argsHash: argsDigest,
      key,
      status: "pending",
      startedAt,
      abortController,
      promise,
    }

    this.entries.set(key, entry)

    // Execute the runner in the background
    try {
      const returned = runnerFn(abortController.signal)
      if (Effect.isEffect(returned)) {
        const fiber = Effect.runFork(returned as Effect.Effect<T, any>)
        entry.fiber = fiber

        fiber.addObserver((exit) => {
          if (entry.status === "discarded") return
          entry.completedAt = performance.now()
          this.stats.active = Math.max(0, this.stats.active - 1)

          if (exit._tag === "Success") {
            entry.status = "completed"
            entry.result = exit.value
            resolvePromise(exit.value)
          } else {
            entry.status = "failed"
            entry.error = exit.cause
            rejectPromise(exit.cause)
          }
        })
      } else {
        // Returned a standard Promise
        Promise.resolve(returned)
          .then((val) => {
            if (entry.status === "discarded") return
            entry.status = "completed"
            entry.completedAt = performance.now()
            entry.result = val
            this.stats.active = Math.max(0, this.stats.active - 1)
            resolvePromise(val)
          })
          .catch((err) => {
            if (entry.status === "discarded") return
            entry.status = "failed"
            entry.completedAt = performance.now()
            entry.error = err
            this.stats.active = Math.max(0, this.stats.active - 1)
            rejectPromise(err)
          })
      }
    } catch (err) {
      entry.status = "failed"
      entry.completedAt = performance.now()
      entry.error = err
      this.stats.active = Math.max(0, this.stats.active - 1)
      rejectPromise(err)
    }

    return entry
  }

  async commit<T>(
    sessionId: string,
    toolId: string,
    args: unknown,
    fallbackRunnerFn?: () => Promise<T> | Effect.Effect<T, any>,
  ): Promise<SpeculativeCommitResult<T>> {
    const argsDigest = hashArgs(args)
    const key = `${sessionId}:${toolId}:${argsDigest}`
    const entry = this.entries.get(key)

    if (entry && entry.status !== "discarded") {
      this.stats.hits++
      const startWait = performance.now()

      try {
        const value = entry.status === "completed" ? entry.result : await entry.promise
        const elapsedMs = performance.now() - startWait
        const totalDuration = (entry.completedAt ?? performance.now()) - entry.startedAt
        const saved = Math.max(0, totalDuration - elapsedMs)
        this.stats.savedMs += saved

        return {
          hit: true,
          status: "completed",
          value,
          elapsedMs,
          savedMs: saved,
        }
      } catch (error) {
        const elapsedMs = performance.now() - startWait
        return {
          hit: true,
          status: "failed",
          error,
          elapsedMs,
          savedMs: 0,
        }
      }
    }

    // Speculative miss
    this.stats.misses++
    if (fallbackRunnerFn) {
      const startFallback = performance.now()
      try {
        const returned = fallbackRunnerFn()
        const value = Effect.isEffect(returned) ? await Effect.runPromise(returned) : await Promise.resolve(returned)
        const elapsedMs = performance.now() - startFallback
        return {
          hit: false,
          status: "completed",
          value,
          elapsedMs,
          savedMs: 0,
        }
      } catch (error) {
        const elapsedMs = performance.now() - startFallback
        return {
          hit: false,
          status: "failed",
          error,
          elapsedMs,
          savedMs: 0,
        }
      }
    }

    return {
      hit: false,
      status: "miss",
      elapsedMs: 0,
      savedMs: 0,
    }
  }

  discard(sessionId: string): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.sessionId === sessionId) {
        if (entry.status === "pending") {
          entry.status = "discarded"
          entry.abortController.abort()
          if (entry.fiber) {
            Effect.runFork(Fiber.interrupt(entry.fiber))
          }
          this.stats.active = Math.max(0, this.stats.active - 1)
          this.stats.discarded++
          this.stats.discards++
        }
        this.entries.delete(key)
      }
    }
  }

  getStats(): SpeculativeStats {
    return { ...this.stats }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.status === "pending") {
        entry.abortController.abort()
        if (entry.fiber) {
          Effect.runFork(Fiber.interrupt(entry.fiber))
        }
      }
    }
    this.entries.clear()
    this.stats = {
      hits: 0,
      misses: 0,
      speculations: 0,
      active: 0,
      discarded: 0,
      discards: 0,
      savedMs: 0,
    }
  }
}

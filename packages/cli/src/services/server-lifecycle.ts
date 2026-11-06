export * as ServerLifecycle from "./server-lifecycle"

import { Cause, Effect, FileSystem } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"

/**
 * Foreground-server lifecycle: PID lock, shutdown marker, previous-run verdict.
 *
 * B14 (2026-11-06): the live server (pid 31637) died silently — no error in
 * the log, no OOM-killer trace the operator could read (dmesg is restricted
 * on this machine), memory at the limit. Nothing in the repo noticed the
 * death: the next start had no idea the previous run ended uncleanly, and
 * the old process had ignored SIGTERM while the replacement fought it for
 * the port. This module closes that hole for `orchestra serve` (default,
 * foreground mode — the mode B14 used):
 *
 * - a PID lock per data directory + port: a second foreground server refuses
 *   to start with a clear error naming the live incumbent, instead of
 *   fighting it for the port or silently sharing the database;
 * - a state file (`server-state.json`) in the data directory: written at
 *   startup with `cleanShutdown: false`, updated to `true` with a reason on
 *   graceful shutdown. A start that finds no clean marker knows the
 *   previous run died uncleanly and says so loudly in the log;
 * - a startup verdict log line: first run / clean previous run / UNCLEAN
 *   previous run / unknown (corrupt or unreadable state).
 *
 * Deliberately NOT covered here, with reasons:
 * - `orchestra serve --service` (managed service) already owns startup
 *   through ServiceClaim + registration self-check; sharing one state file
 *   between the two modes would confuse the verdict, so the service mode
 *   does not write this file.
 * - `orchestra serve --stdio` (a TUI child) is owned by its parent process;
 *   its lifetime is the parent's lease, not this marker.
 * - `/health` does not carry the verdict: it is an unauthenticated
 *   Protocol endpoint whose body carries no paths or pids by design
 *   (AI_ATLAS.md, "Health endpoint"), and changing its shape requires a
 *   client regeneration. The verdict lives in the startup log and in the
 *   state file, which the watchdog script reads.
 * - The watchdog itself is a shell script, `scripts/server-watchdog.sh`:
 *   it restarts an uncleanly dead server with backoff and a restart cap,
 *   and never restarts a clean shutdown or a lock held by a live server.
 *   A full in-process supervisor is out of scope: a supervisor inside the
 *   process it watches cannot report its own SIGKILL.
 */

export interface LockInfo {
  readonly pid: number
  readonly hostname: string
  /** Null when the OS picks the port (no explicit `--port`). */
  readonly port: number | null
  readonly mode: string
  readonly startedAt: string
}

export type PreviousRunVerdict = "first" | "clean" | "unclean" | "unknown"

export interface PreviousRun {
  readonly verdict: PreviousRunVerdict
  readonly pid?: number
  readonly startedAt?: string
  /** ISO time of the clean shutdown, when the verdict is "clean". */
  readonly endedAt?: string
  /** Reason recorded at the clean shutdown, when the verdict is "clean". */
  readonly reason?: string
  /** Why the verdict is "unknown" (corrupt or unreadable state file). */
  readonly detail?: string
}

export interface ServerState {
  readonly version: 1
  readonly pid: number
  readonly hostname: string
  readonly port: number | null
  readonly mode: string
  readonly startedAt: string
  readonly cleanShutdown: boolean
  readonly lastShutdown: { readonly at: string; readonly reason: string } | null
  readonly previousRun: PreviousRun | null
}

/** `server-state.json` in the data directory — one file per install. */
export const stateFile = (dataDir: string) => path.join(dataDir, "server-state.json")

/** One lock per port; auto-port servers share the port-less lock. */
export const lockFile = (dataDir: string, port: number | null) =>
  path.join(dataDir, port === null ? "server.lock" : `server-${port}.lock`)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseState(text: string): ServerState | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const state = parsed as Partial<ServerState>
    if (
      state.version !== 1 ||
      typeof state.pid !== "number" ||
      typeof state.hostname !== "string" ||
      typeof state.startedAt !== "string" ||
      typeof state.cleanShutdown !== "boolean"
    )
      return undefined
    return state as ServerState
  } catch {
    return undefined
  }
}

/**
 * What the previous run left behind. "first" when no state file exists,
 * "unknown" when it exists but cannot be parsed (never throws: a corrupt
 * marker must not block a start).
 */
export const readPreviousRun = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(stateFile(dataDir)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return { verdict: "first" } satisfies PreviousRun
    const state = parseState(text)
    if (state === undefined)
      return {
        verdict: "unknown",
        detail: "server-state.json exists but is not a readable lifecycle state (corrupt or from an older format)",
      } satisfies PreviousRun
    if (state.cleanShutdown)
      return {
        verdict: "clean",
        pid: state.pid,
        startedAt: state.startedAt,
        endedAt: state.lastShutdown?.at,
        reason: state.lastShutdown?.reason,
      } satisfies PreviousRun
    return { verdict: "unclean", pid: state.pid, startedAt: state.startedAt } satisfies PreviousRun
  })

export class ServerAlreadyRunningError extends Error {
  readonly pid: number
  readonly port: number | null
  readonly startedAt: string
  constructor(pid: number, port: number | null, startedAt: string) {
    super(
      `Another orchestra server is already running (pid ${pid}, started ${startedAt}, ` +
        `port ${port === null ? "auto-assigned" : port}). Stop it first ` +
        `(\`orchestra serve\` refuses to share a database and a port with a live server). ` +
        `If that process is gone, remove the stale lock file and start again.`,
    )
    this.name = "ServerAlreadyRunningError"
    this.pid = pid
    this.port = port
    this.startedAt = startedAt
  }
}

function readLock(dataDir: string, port: number | null) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(lockFile(dataDir, port)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null) return undefined
      const pid = (parsed as Partial<LockInfo>).pid
      const startedAt = (parsed as Partial<LockInfo>).startedAt
      if (typeof pid !== "number" || typeof startedAt !== "string") return undefined
      return { pid, startedAt } as const
    } catch {
      return undefined
    }
  })
}

/**
 * Take the PID lock, exclusively (`wx` create). A lock naming a live pid
 * fails with ServerAlreadyRunningError; a lock naming a dead pid is stale
 * and is reclaimed, loudly. A lock that cannot be parsed is treated as
 * stale — a half-written lock must never wedge startup forever.
 */
export const acquireLock = (dataDir: string, info: LockInfo) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.ignore)
    const file = lockFile(dataDir, info.port)
    const written = yield* fs
      .writeFileString(file, JSON.stringify(info), { flag: "wx" })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    if (written) return info
    const holder = yield* readLock(dataDir, info.port)
    if (holder !== undefined && alive(holder.pid))
      return yield* Effect.fail(new ServerAlreadyRunningError(holder.pid, info.port, holder.startedAt))
    yield* Effect.logWarning("Reclaiming a stale server lock", {
      file,
      holderPid: holder?.pid,
      holderStartedAt: holder?.startedAt,
    })
    yield* fs.remove(file).pipe(Effect.ignore)
    const reclaimed = yield* fs
      .writeFileString(file, JSON.stringify(info), { flag: "wx" })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    if (!reclaimed)
      return yield* Effect.fail(
        new Error(`Could not take the server lock ${file}: another server started between the check and the claim.`),
      )
    return info
  })

/** Remove the lock, but only when it still names this process. */
export const releaseLock = (dataDir: string, port: number | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const holder = yield* readLock(dataDir, port)
    if (holder === undefined || holder.pid !== process.pid) return
    yield* fs.remove(lockFile(dataDir, port)).pipe(Effect.ignore)
  })

function writeState(dataDir: string, state: ServerState) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = stateFile(dataDir)
    // Write-then-rename: a SIGKILL mid-write leaves the old state, not a
    // half-written one — a corrupt marker would only ever read "unknown".
    // A3-17: the state names the server's pid and port, so it is created
    // 0600 like the lock and the database. The temp name carries the pid
    // and a random suffix — a fixed temp name let two writers collide.
    yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.ignore)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    yield* fs.writeFileString(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    yield* fs.rename(temporary, file)
  })
}

/** Record this run as started (unclean until a graceful shutdown says otherwise). */
export const markStarted = (dataDir: string, info: LockInfo, previousRun: PreviousRun) =>
  writeState(dataDir, {
    version: 1,
    pid: info.pid,
    hostname: info.hostname,
    port: info.port,
    mode: info.mode,
    startedAt: info.startedAt,
    cleanShutdown: false,
    lastShutdown: null,
    previousRun,
  })

/**
 * Record a graceful shutdown and drop the lock. Only touches the state when
 * it still names this process — a newer run's state is never clobbered by
 * an old process's late finalizer.
 */
export const markStopped = (dataDir: string, reason: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(stateFile(dataDir)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return
    const state = parseState(text)
    if (state === undefined || state.pid !== process.pid) return
    // A3-15: the old code swallowed a failed marker write with Effect.ignore
    // — the next boot then reported this run as unclean, and nobody knew the
    // marker write had failed. Say so loudly instead: the shutdown still
    // completes and the lock is still released, but the missing marker is
    // visible in the log.
    yield* writeState(dataDir, {
      ...state,
      cleanShutdown: true,
      lastShutdown: { at: new Date().toISOString(), reason },
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "could not write the clean-shutdown marker; the next boot will report this run as unclean",
          { cause: Cause.pretty(cause) },
        ),
      ),
    )
    yield* releaseLock(dataDir, state.port)
  })

/**
 * One loud log line about the previous run, at startup — in the Effect log
 * (the opencode log file) AND on stdout, because a `serve` log only carries
 * console output: an operator tailing `serve.log` must see the verdict next
 * to "server listening", not only in the log file.
 */
export const reportPreviousRun = (previousRun: PreviousRun) =>
  Effect.gen(function* () {
    const line =
      previousRun.verdict === "unclean"
        ? `Previous server run ended UNCLEANLY (pid ${previousRun.pid}, started ${previousRun.startedAt}): no clean-shutdown marker — the process was killed or crashed.`
        : previousRun.verdict === "unknown"
          ? `Previous server run state is unreadable (${previousRun.detail}); treating the previous run as unclean.`
          : previousRun.verdict === "clean"
            ? `Previous server run ended cleanly (pid ${previousRun.pid}, started ${previousRun.startedAt}, ended ${previousRun.endedAt}, ${previousRun.reason}).`
            : "First server run in this data directory (no previous state)."
    yield* Effect.sync(() => console.log(`[lifecycle] ${line}`))
    if (previousRun.verdict === "unclean")
      return yield* Effect.logWarning(
        "Previous server run ended UNCLEANLY: no clean-shutdown marker (the process was killed or crashed). " +
          "Sessions with an unreleased execution claim will be resumed by the startup sweep; " +
          "check the previous server log for the last thing it did.",
        { pid: previousRun.pid, startedAt: previousRun.startedAt },
      )
    if (previousRun.verdict === "unknown")
      return yield* Effect.logWarning("Previous server run state is unreadable; treating the previous run as unclean.", {
        detail: previousRun.detail,
      })
    if (previousRun.verdict === "clean")
      return yield* Effect.logInfo("Previous server run ended cleanly.", {
        pid: previousRun.pid,
        startedAt: previousRun.startedAt,
        endedAt: previousRun.endedAt,
        reason: previousRun.reason,
      })
    return yield* Effect.logInfo("First server run in this data directory (no previous state).")
  })

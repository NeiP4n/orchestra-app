export * as FileMutation from "./file-mutation.js"

import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@orchestra/util/fs-util"
import { Bom } from "@orchestra/util/bom"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import type { FileAccess } from "./file-access.js"

export type Target = Pick<FileAccess.Target, "absolute" | "resource">

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
  /** Serialize a complete read/prepare/write mutation transaction by resolved path. */
  readonly withLock: (
    targets: ReadonlyArray<string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, Environment.WrongKind | Environment.Failed>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/FileMutation") {}

export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  return Bom.decodeBytes((yield* files.read(target)).bytes)
})

export const syncTextBom = Effect.fn("FileMutation.syncTextBom")(function* (
  files: Files,
  target: string,
  bom: boolean,
) {
  const synced = Bom.syncBytes((yield* files.read(target)).bytes, bom)
  if (synced.bytes) yield* files.write(target, synced.bytes)
  return synced.text
})

/** Share transaction locks across Location graphs that address the same file. */
const transactionLocks = KeyedMutex.makeUnsafe<string>()

// A cross-process lock is a file next to the target, created with O_EXCL: two
// processes (or two servers over one checkout) can never both hold it. The
// holder's pid is inside, so a lock left by a dead process is stolen instead
// of blocking writes forever.
const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_POLL_MS = 25

const lockPath = (target: string) => `${target}.orchestra-lock`

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

const acquireFileLock = (target: string): Effect.Effect<void, Environment.Failed> =>
  Effect.gen(function* () {
    const lock = lockPath(target)
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      const acquired = yield* Effect.sync(() => {
        try {
          // A prospective file in a new directory has no parent yet: the lock
          // lives next to the target, so the directory must exist first.
          mkdirSync(path.dirname(lock), { recursive: true })
          const fd = openSync(lock, "wx")
          try {
            writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
          } finally {
            closeSync(fd)
          }
          return true
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause
          return false
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.fail(new Environment.Failed({ path: target, cause })),
        ),
      )
      if (acquired) return
      // Steal a lock whose holder died or has held it far past any single write.
      yield* Effect.sync(() => {
        try {
          const content = readFileSync(lock, "utf8")
          const pid = Number.parseInt(content.split("\n")[0] ?? "", 10)
          if (Number.isNaN(pid) || !isAlive(pid) || Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS)
            unlinkSync(lock)
        } catch {
          // The lock vanished (or is unreadable): retrying re-reads it.
        }
      })
      if (Date.now() >= deadline)
        return yield* new Environment.Failed({
          path: target,
          cause: new Error(`Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the file lock on ${target}`),
        })
      yield* Effect.sleep(`${LOCK_POLL_MS} millis`)
    }
  })

const releaseFileLock = (target: string) =>
  Effect.sync(() => {
    const lock = lockPath(target)
    try {
      // Only remove our own lock: a successor may have taken it already.
      const content = readFileSync(lock, "utf8")
      if (Number.parseInt(content.split("\n")[0] ?? "", 10) === process.pid) unlinkSync(lock)
    } catch {
      // Already gone (stolen as stale, or removed with the file): nothing to do.
    }
  })

/**
 * Mutation locking is process-local and serializes cooperating OpenCode
 * changes; external writes can still race.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      [...new Set(targets.map(FSUtil.resolve))]
        .sort()
        .reduceRight((result, target) => transactionLocks.withLock(target)(result), effect)
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.absolute)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* acquireFileLock(target.absolute)
              return yield* effect.pipe(Effect.ensuring(releaseFileLock(target.absolute)))
            }),
          ),
        )

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    // Write through a temp file in the same directory and rename it over the
    // target: readers never see a torn file, and a failed write leaves the
    // previous content in place (snapshot restored below). A final symlink is
    // the exception: renaming would replace the link itself, so symlinks keep
    // the direct write, still under the lock and with a snapshot rollback.
    const atomicWrite = (target: Target, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const previous = yield* environment.files.read(target.absolute).pipe(
          Effect.map((result) => result.bytes),
          Effect.catchTag("Environment.NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Environment.WrongKind", (error) =>
            Effect.fail(new Environment.Failed({ path: target.absolute, cause: error })),
          ),
        )
        const isSymlink = yield* environment.files.stat(target.absolute).pipe(
          Effect.map((info) => info.type === "symlink"),
          Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
        )
        const temp = `${target.absolute}.${process.pid}.${randomUUID()}.tmp`
        // The public write surface only fails with Failed | WrongKind: a
        // missing parent or wrong kind surfacing from the temp write or the
        // rename is a failed write, not a missing target.
        const toFailed = (error: Environment.Failed | Environment.NotFound | Environment.WrongKind) =>
          error._tag === "Environment.Failed"
            ? error
            : new Environment.Failed({ path: target.absolute, cause: error })
        const rollback = Effect.gen(function* () {
          yield* environment.files.remove(temp).pipe(Effect.ignore)
          if (previous !== undefined)
            yield* environment.files.write(target.absolute, previous).pipe(Effect.ignore)
        })
        if (isSymlink) {
          yield* environment.files.write(target.absolute, bytes).pipe(Effect.catch((error) => rollback.pipe(Effect.andThen(Effect.fail(toFailed(error))))))
          return
        }
        yield* Effect.gen(function* () {
          yield* environment.files.write(temp, bytes)
          yield* environment.files.move(temp, target.absolute)
        }).pipe(Effect.catch((error) => rollback.pipe(Effect.andThen(Effect.fail(toFailed(error))))))
      })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* environment.files.stat(input.target.absolute).pipe(
            Effect.as(true),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* atomicWrite(
            input.target,
            typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content,
          )
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = Bom.split(input.content)
          const current = yield* environment.files.read(input.target.absolute, { offset: 0, length: 3 }).pipe(
            Effect.map((result) => result.bytes),
            Effect.catchTag("Environment.NotFound", () => Effect.undefined),
          )
          yield* atomicWrite(
            input.target,
            new TextEncoder().encode(Bom.join(next.text, Boolean(current && Bom.has(current)) || next.bom)),
          )
          return writeResult(input.target, current !== undefined)
        }),
      ),
    )

    return Service.of({ withLock, write, writeTextPreservingBom })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })

/**
 * Single-file writes are atomic: temp file + rename under a process-local and
 * a cross-process file lock, with the previous bytes snapshotted and restored
 * when the write fails. Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.

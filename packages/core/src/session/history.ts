import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { Instructions } from "../instructions/index.js"
import { InstructionState } from "./instruction-state.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)

/**
 * Which completed compactions bound a history read. Local summaries always do. Native
 * windows do for model-neutral readers (`latest`), never for the original transcript
 * (`local`), and only when the target model can replay them (a provenance).
 */
export type Boundary = "latest" | "local" | SessionProviderContext.Provenance

const replayable = (message: SessionMessage.Info, boundary: Boundary) =>
  !SessionProviderContext.isCheckpoint(message) ||
  boundary === "latest" ||
  (boundary !== "local" && SessionProviderContext.compatible(message.providerContext.provenance, boundary))

export const latestCompaction = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
  beforeSeq?: number,
) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        beforeSeq === undefined ? undefined : lt(SessionMessageTable.seq, beforeSeq),
        boundary === "latest"
          ? undefined
          : or(
              sql`json_extract(${SessionMessageTable.data}, '$.providerContext') is null`,
              boundary === "local"
                ? undefined
                : and(
                    ...Object.entries(boundary).map(
                      ([key, value]) =>
                        sql`json_extract(${SessionMessageTable.data}, ${`$.providerContext.provenance.${key}`}) = ${value}`,
                    ),
                  ),
            ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.tap((message) =>
      SessionProviderContext.isCheckpoint(message)
        ? SessionProviderContext.validate(message.providerContext)
        : Effect.void,
    ),
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const readRows = (db: DatabaseService, sessionID: SessionSchema.ID, fromSeq?: number) =>
  db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), fromSeq === undefined ? undefined : gte(SessionMessageTable.seq, fromSeq)))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)

/**
 * Decode history rows one by one. A single corrupt row is quarantined — logged
 * and skipped — instead of failing the whole load: one bad row must never kill
 * a session. The row stays in the database, so every load warns about it until
 * someone repairs or prunes it.
 */
export const decodeRows = (rows: Array<typeof SessionMessageTable.$inferSelect>, sessionID: SessionSchema.ID) =>
  Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(
      Effect.map((message) => ({ seq: row.seq, message })),
      Effect.catchTag("Session.MessageDecodeError", () =>
        Effect.logWarning("session history: битая строка пропущена, сессия грузится дальше", {
          sessionID,
          messageID: row.id,
          seq: row.seq,
        }).pipe(Effect.as(undefined)),
      ),
    ),
  ).pipe(
    Effect.map((entries) => entries.filter((entry) => entry !== undefined)),
  )

const messageEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  const compaction = yield* latestCompaction(db, sessionID, boundary)
  let entries = yield* decodeRows(yield* readRows(db, sessionID, compaction?.seq), sessionID)
  // The latest compaction's own summary row is corrupt: its summary is lost, so
  // degrade to the previous completed compaction — its summary plus everything
  // after it — instead of loading a bare post-compaction tail. With no earlier
  // compaction, the re-read starts from the beginning: the full transcript.
  if (compaction !== undefined && !entries.some((entry) => entry.seq === compaction.seq)) {
    const previous = yield* latestCompaction(db, sessionID, boundary, compaction.seq)
    yield* Effect.logWarning("session history: саммари последней компакции битое, откат к предыдущей", {
      sessionID,
      seq: compaction.seq,
      previousSeq: previous?.seq ?? null,
    })
    entries = yield* decodeRows(yield* readRows(db, sessionID, previous?.seq), sessionID)
  }
  // Re-expansion may cross a native checkpoint whose completion already advanced the instruction
  // epoch: the baseline supersedes the chronological updates before it. Forks seed their baseline
  // at sequence 0 but retain parent sequences, so the copied checkpoint still retires them.
  const native = entries.findLast((entry) => SessionProviderContext.isCheckpoint(entry.message))
  // Skipped native checkpoints are not textual summaries. Their original transcript remains available.
  return entries.filter(
    (entry) =>
      !(entry.message.type === "system" && native && entry.seq < native.seq) && replayable(entry.message, boundary),
  )
})

export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  return (yield* messageEntries(db, sessionID, boundary)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        return {
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/** Returns the session's first user message. */
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
  return message?.type === "user" ? message : undefined
})

export * as SessionHistory from "./history.js"

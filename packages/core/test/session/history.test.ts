import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { AbsolutePath } from "@orchestra/core/schema"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionHistory } from "@orchestra/core/session/history"
import { SessionSchema } from "@orchestra/core/session/schema"
import { SessionMessageTable, SessionTable } from "@orchestra/core/session/sql"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const setup = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "history-test",
        directory: "/project",
        title: "History test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return db
  })

const insert = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  row: { id: string; type: "user" | "compaction"; seq: number; data: unknown },
) =>
  db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(row.id),
      session_id: sessionID,
      type: row.type,
      seq: row.seq,
      data: row.data as never,
    })
    .run()
    .pipe(Effect.orDie)

const userData = (text: string) => ({ time: { created: Date.now() }, text })
const compactionData = (summary: string) => ({
  time: { created: Date.now() },
  status: "completed",
  reason: "manual",
  summary,
  recent: "",
})

describe("SessionHistory.load with corrupt rows", () => {
  it.effect("quarantines one bad row and loads the rest of the session", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_history_quarantine")
      const db = yield* setup(sessionID)
      yield* insert(db, sessionID, { id: "msg_hist_1", type: "user", seq: 1, data: userData("first") })
      yield* insert(db, sessionID, { id: "msg_hist_2", type: "user", seq: 2, data: { time: { created: 1 } } })
      yield* insert(db, sessionID, { id: "msg_hist_3", type: "user", seq: 3, data: userData("third") })

      const messages = yield* SessionHistory.load(db, sessionID, "latest")

      expect(messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "first",
        "third",
      ])
    }),
  )

  it.effect("falls back to the previous compaction when the latest summary row is corrupt", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_history_compaction_fallback")
      const db = yield* setup(sessionID)
      yield* insert(db, sessionID, { id: "msg_hist_c1", type: "compaction", seq: 1, data: compactionData("old summary") })
      yield* insert(db, sessionID, { id: "msg_hist_2", type: "user", seq: 2, data: userData("before") })
      // Corrupt latest compaction: SQL still sees status completed, so it is the
      // boundary — but the row itself does not decode, so its summary is lost.
      yield* insert(db, sessionID, {
        id: "msg_hist_c2",
        type: "compaction",
        seq: 3,
        data: { time: { created: Date.now() }, status: "completed", reason: "manual", summary: 123, recent: "" },
      })
      yield* insert(db, sessionID, { id: "msg_hist_4", type: "user", seq: 4, data: userData("after") })

      const messages = yield* SessionHistory.load(db, sessionID, "latest")

      const summaries = messages.flatMap((message) => (message.type === "compaction" && "summary" in message ? [message.summary] : []))
      expect(summaries).toEqual(["old summary"])
      expect(messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "compaction",
        "before",
        "after",
      ])
    }),
  )
})

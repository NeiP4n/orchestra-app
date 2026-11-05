import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { ForgeJournal } from "@orchestra/core/tool/plugin/forge-journal"
import { Global } from "@orchestra/util/global"

describe("ForgeJournal", () => {
  test("builds a journal-only fact naming who generated what and what it replaced", () => {
    const fact = ForgeJournal.forgeFact(
      {
        kind: "mcp",
        action: "registered",
        name: "docs",
        source: "openapi",
        by: "ses_1",
        previous: { type: "local", command: ["node", "old.mjs"] },
        detail: { module: "/cfg/mcp/docs.mjs", tools: ["search"] },
      },
      1_700_000_000_000,
    )
    expect(fact.id).toBe("evt:forge:mcp:docs:1700000000000")
    expect(fact.type).toBe("forge.registered")
    expect(fact.collection).toBeUndefined()
    expect(fact.data).toEqual({
      kind: "mcp",
      action: "registered",
      name: "docs",
      source: "openapi",
      by: "ses_1",
      previous: { type: "local", command: ["node", "old.mjs"] },
      detail: { module: "/cfg/mcp/docs.mjs", tools: ["search"] },
    })
  })

  test("records a registration in the journal when a database is available", async () => {
    const run = Effect.runPromise(
      Effect.gen(function* () {
        yield* ForgeJournal.recordForge({
          kind: "plugin",
          action: "registered",
          name: "acme-plugin",
          by: "ses_1",
          previous: null,
        })
        return yield* AutoloopStore.readLog()
      }).pipe(
        Effect.provide(Database.layer({ path: ":memory:" })),
        Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
        Effect.scoped,
      ),
    )
    const facts = await run
    expect(facts).toHaveLength(1)
    expect(facts[0]?.type).toBe("forge.registered")
    expect(facts[0]?.data).toMatchObject({ kind: "plugin", name: "acme-plugin", by: "ses_1", previous: null })
  })

  test("does not fail a registration when no database is available", async () => {
    await Effect.runPromise(ForgeJournal.recordForge({ kind: "mcp", action: "removed", name: "docs" }))
  })
})

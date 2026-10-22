import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { InstructionBuiltIns } from "@orchestra/core/instructions/builtins"
import { Instructions } from "@orchestra/core/instructions/index"
import { Location } from "@orchestra/core/location"
import { tempLocationLayer } from "./fixture/location"

// The tool description is roughly 1400 characters and is sent on every request. The built-in
// may point the agent at the tool, but it must stay cheaper than the description it sits next to.
const DESCRIPTION_BUDGET = 1400

// Reads the real built-in service and renders the way request assembly does: read → values →
// renderInitial. Sources whose value is absent from `values` render nothing, so a source that
// never made it into the combined list cannot be seen here at all.
const observed = async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* InstructionBuiltIns.Service
      const list = yield* source.load()
      const read = yield* Instructions.read(list)
      const values: Record<string, Schema.Json> = {}
      for (const entry of read) if (typeof entry.value === "string") values[entry.key] = entry.value
      return { list, values }
    }).pipe(Effect.provide(AppNodeBuilder.build(InstructionBuiltIns.node, [Location.node.replace(tempLocationLayer)]))),
  )

const rendered = async () => {
  const { list, values } = await observed()
  return Instructions.renderInitial(list, values)
}

/** The prompt text of one source alone, so a length budget measures that source and not the block. */
const renderedAlone = async (key: string) => {
  const { list, values } = await observed()
  if (!Object.hasOwn(values, key)) return ""
  return Instructions.renderInitial(list, { [key]: values[key] })
}

const KEY = Instructions.Key.make("core/skill-catalog")

describe("skill catalog built-in instruction", () => {
  test("tells the agent to search the catalog at the start of a task, unasked", async () => {
    const text = await rendered()

    expect(text).toContain("<skill-catalog>")
    expect(text).toContain("At the start of a new task")
    expect(text).toContain("skill_catalog")
    expect(text).toContain("do not wait to be asked")
  })

  test("says how to phrase a query and how the two cost levels differ", async () => {
    const text = await rendered()

    expect(text).toContain("Write the query in English")
    expect(text).toContain("translate a request that arrived in another language")
    expect(text).toContain("search is cheap")
    expect(text).toContain("get reads the skill text")
    expect(text).toContain("only when you would really work by that skill")
  })

  test("keeps the task in charge and spares the catalog on trivial work", async () => {
    const text = await rendered()

    expect(text).toContain("applying a skill never replaces doing the task itself")
    expect(text).toContain("Skip the catalog for trivial, everyday work")
  })

  test("does not restate the tool description next to it in the prompt", async () => {
    const text = await renderedAlone(KEY)

    expect(text).toContain("<skill-catalog>")
    // The description already carries the action list, the permission surfaces and the
    // "a hit is metadata only" rule. Repeating them here spends prompt on a second copy.
    expect(text).not.toContain("Permission:")
    expect(text).not.toContain("A hit is metadata only")
    expect(text).not.toContain("Actions:")
    // Raw MCP names are deliberately not offered: skill_catalog is the advertised path.
    expect(text).not.toContain("skillsmp_search_skills")
    expect(text).not.toContain("skillsmp_get_skill")
    expect(text.length).toBeLessThan(DESCRIPTION_BUDGET)
  })

  test("reaches the session instruction list the runner builds", async () => {
    // The built-in lives in the service layer, but a session only sees it if request assembly
    // loads the built-ins and combines that list. Checking the wiring keeps a producer from
    // sitting in the file, green in its own test, and absent from every prompt.
    const source = await Bun.file(new URL("../src/session/context.ts", import.meta.url)).text()

    expect(source).toContain("builtins: builtins.load()")
    expect(source).toContain("loaded.builtins,")
  })
})

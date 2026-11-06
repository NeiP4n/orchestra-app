import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { InstructionBuiltIns } from "@orchestra/core/instructions/builtins"
import { InstructionThinking } from "@orchestra/core/instructions/thinking"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { FSUtil } from "@orchestra/util/fs-util"
import { Global } from "@orchestra/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"

const read = (list: ReturnType<typeof InstructionThinking.thinkingSource>) => Effect.runPromise(readInitial(list))

// The repository this test lives in ships script/check.ts and script/map.ts, while the plain
// fixture below does not: the same built-in instructions must read differently in each.
const repository = path.resolve(import.meta.dir, "..", "..", "..")
const temporary = os.tmpdir()

const builtIns = (projectDirectory: string) =>
  testEffect(
    AppNodeBuilder.build(InstructionBuiltIns.node, [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location(
              { directory: AbsolutePath.make(FSUtil.resolve("/repo/packages/core")) },
              {
                projectDirectory: AbsolutePath.make(projectDirectory),
                vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) },
              },
            ),
          ),
        ),
      ),
      Global.node.replace(Global.layerWith({ config: temporary, tmp: temporary })),
    ]),
  )

describe("InstructionThinking", () => {
  test("states the four reasoning strategies", async () => {
    const { text, values } = await read(InstructionThinking.thinkingSource())

    expect(Object.keys(values)).toEqual(["core/thinking"])
    expect(text.startsWith("<thinking>")).toBe(true)
    expect(text.endsWith("</thinking>")).toBe(true)
    for (const strategy of ["Tree-of-Thoughts", "Inversion", "Devil's Advocate", "Budget-Aware"]) {
      expect(text).toContain(strategy)
    }
    // The labels alone would pass the check above while saying nothing, so each rule keeps the
    // behaviour that makes it useful.
    expect(text).toContain("check the cheapest branch first")
    expect(text).toContain("before editing")
    expect(text).toContain("the case that falsifies it")
    expect(text).toContain("after two failures change the query")
  })

  test("does not resend the rules once a session admitted them", async () => {
    const list = InstructionThinking.thinkingSource()
    const admitted = await read(list)

    const update = await Effect.runPromise(readUpdate(list, admitted))

    expect(update.changed).toBe(false)
  })

  test("names the project's own scripts only when the project ships them", async () => {
    const plain = (await read(InstructionThinking.thinkingSource())).text
    const scripted = (await read(InstructionThinking.thinkingSource({ scripts: true }))).text

    expect(plain).not.toContain("script/check.ts")
    expect(plain).not.toContain("script/map.ts")
    expect(scripted).toContain("bun script/check.ts")
    expect(scripted).toContain("bun script/map.ts")
    expect(scripted.length).toBeGreaterThan(plain.length)
  })
})

describe("InstructionBuiltIns task method", () => {
  const plain = builtIns(FSUtil.resolve("/repo"))

  plain.effect("asks three questions before code and does the riskiest part first", () =>
    Effect.gen(function* () {
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(Object.keys(initialized.values)).toContain("core/ask-first")
      expect(Object.keys(initialized.values)).toContain("core/riskiest-first")
      expect(initialized.text).toContain("<ask-first>")
      expect(initialized.text).toContain("exactly three questions")
      expect(initialized.text).toContain("<riskiest-first>")
      expect(initialized.text).toContain("riskiest, least-known part of a task first")
    }),
  )
})

describe("InstructionBuiltIns thinking rules", () => {
  const plain = builtIns(FSUtil.resolve("/repo"))
  const shipping = builtIns(repository)

  plain.effect("are part of the built-in instructions, before the tool routing", () =>
    Effect.gen(function* () {
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(Object.keys(initialized.values)).toContain("core/thinking")
      expect(initialized.text).toContain("<thinking>")
      expect(initialized.text.indexOf("<thinking>")).toBeLessThan(initialized.text.indexOf("<tool-routing>"))
      // A project without the scripts must not be told to run them.
      expect(initialized.text).not.toContain("bun script/check.ts")
    }),
  )

  shipping.effect("name the fast-check and map scripts in a project that ships them", () =>
    Effect.gen(function* () {
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(initialized.text).toContain("bun script/check.ts")
      expect(initialized.text).toContain("bun script/map.ts")
    }),
  )
})

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { LanguageModel, ToolCallPart, ToolRuntime } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { TestLLM } from "@orchestra/ai/testing"
import { ID, Model, Ref } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { parseFixed, runRepairLoop } from "@orchestra/core/recovery/agent"
import { listRecoveryModels } from "@orchestra/core/recovery/models"
import { isForbiddenCommand, recoveryTools, resolveInRoot } from "@orchestra/core/recovery/tools"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const model = LanguageModel.make({ id: "test", provider: "test-provider", route: OpenAIChat.route })
const ref = Ref.make({ providerID: Provider.ID.make("test-provider"), id: ID.make("test") })

const testLLM = TestLLM.layer({ fallback: [] })
const layer = Layer.merge(testLLM, TestLLM.clientLayer.pipe(Layer.provide(testLLM)))
const it = testEffect(layer)

describe("recovery model list", () => {
  test("offers every enabled model in catalog order, no provider is excluded by name", () => {
    const models = listRecoveryModels([
      { providerID: "anymodel", id: "opus-5", name: "Opus 5" },
      { providerID: "lix", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
      { providerID: "klinch", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { providerID: "opencode", id: "crouton-alpha-free", name: "Crouton Alpha Free" },
    ] as unknown as ReadonlyArray<Model.Info>)
    expect(models.map((item) => `${item.providerID}/${item.id}`)).toEqual([
      "anymodel/opus-5",
      "lix/deepseek-v4.1-flash",
      "klinch/claude-sonnet-4-5",
      "opencode/crouton-alpha-free",
    ])
  })

  test("an empty catalog offers nothing instead of a dead model", () => {
    expect(listRecoveryModels([])).toEqual([])
  })
})

describe("recovery tool confinement", () => {
  test("paths inside the root resolve, paths outside do not", () => {
    const root = "/tmp/orchestra-test"
    expect(resolveInRoot(root, "packages/core/src/x.ts")).toBe(path.join(root, "packages/core/src/x.ts"))
    expect(resolveInRoot(root, "../escape.txt")).toBeUndefined()
    expect(resolveInRoot(root, "/etc/passwd")).toBeUndefined()
  })

  test("destructive shell commands are refused", () => {
    expect(isForbiddenCommand("rm -rf /")).toBe(true)
    expect(isForbiddenCommand("rm -rf ~/projects")).toBe(true)
    expect(isForbiddenCommand("rm -rf $HOME")).toBe(true)
    expect(isForbiddenCommand("mkfs.ext4 /dev/sda1")).toBe(true)
    expect(isForbiddenCommand("shutdown -h now")).toBe(true)
    expect(isForbiddenCommand(":(){:|:&};:")).toBe(true)
  })

  test("ordinary repair commands are allowed", () => {
    expect(isForbiddenCommand("bun test packages/core/test/recovery.test.ts")).toBe(false)
    expect(isForbiddenCommand("rm -rf ./dist")).toBe(false)
    expect(isForbiddenCommand("git status")).toBe(false)
  })

  it.effect("a write outside the root is refused by the tool, not executed", () =>
    Effect.gen(function* () {
      const tools = recoveryTools("/tmp/orchestra-test")
      const settled = yield* ToolRuntime.dispatch(
        tools,
        ToolCallPart.make({ id: "c1", name: "write_file", input: { path: "../evil.txt", content: "x" } }),
      )
      expect(settled.result.type).toBe("json")
      const value = (settled.result as { value: { success: boolean; output: string } }).value
      expect(value.success).toBe(false)
      expect(value.output).toContain("выходит за пределы репозитория")
    }),
  )
})

describe("recovery repair loop", () => {
  it.effect("runs the tool the model calls and reports the fix", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "orchestra-recovery-")))
      yield* Effect.tryPromise(() => Bun.write(path.join(root, "hello.txt"), "hello orchestra"))
      try {
        const llm = yield* TestLLM.Service
        yield* llm.push(
          TestLLM.tool("call_1", "read_file", { path: "hello.txt" }),
          TestLLM.text("Готово. Исправлено: прочитал файл hello.txt.", "final"),
        )
        const result = yield* runRepairLoop({
          model,
          ref,
          messages: [{ role: "user", content: "Проверь файл hello.txt" }],
          root,
        })
        expect(result.reply).toContain("Исправлено: прочитал файл hello.txt.")
        expect(result.fixed).toBe("прочитал файл hello.txt.")
        expect(result.steps).toHaveLength(1)
        expect(result.steps[0]?.tool).toBe("read_file")
        expect(result.steps[0]?.success).toBe(true)
        expect(result.steps[0]?.output).toContain("hello orchestra")
      } finally {
        yield* Effect.tryPromise(() => rm(root, { recursive: true, force: true }))
      }
    }),
  )

  it.effect("a direct answer without tools finishes with no steps", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      yield* llm.push(TestLLM.text("Всё в порядке, чинить нечего.", "final"))
      const result = yield* runRepairLoop({
        model,
        ref,
        messages: [{ role: "user", content: "Что сломалось?" }],
        root: tmpdir(),
      })
      expect(result.reply).toBe("Всё в порядке, чинить нечего.")
      expect(result.steps).toEqual([])
      expect(result.fixed).toBeUndefined()
    }),
  )

  it.effect("a refused tool result reaches the model as a normal result", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      yield* llm.push(
        TestLLM.tool("call_1", "run_shell", { command: "rm -rf /" }),
        TestLLM.text("Команда запрещена. Исправлено: ничего не сломал.", "final"),
      )
      const result = yield* runRepairLoop({
        model,
        ref,
        messages: [{ role: "user", content: "Удали всё" }],
        root: tmpdir(),
      })
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]?.success).toBe(false)
      expect(result.steps[0]?.output).toContain("запрещена")
      expect(result.fixed).toBe("ничего не сломал.")
    }),
  )
})

describe("recovery fixed-line parsing", () => {
  test("finds the Исправлено line", () => {
    expect(parseFixed("Что-то сломалось.\nИсправлено: починил конфиг.")).toBe("починил конфиг.")
    expect(parseFixed("Fixed: rebuilt the app.")).toBe("rebuilt the app.")
    expect(parseFixed("Ничего не починил.")).toBeUndefined()
  })
})

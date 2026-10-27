import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Config } from "@orchestra/core/config"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { McpForgeTool } from "@orchestra/core/tool/plugin/mcp-forge"
import type { Patch } from "@orchestra/schema/config"
import { Effect, Layer, Stream } from "effect"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, waitForTool } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const patches: Patch[] = []
// Config.testLayer() has no update; the forge records the patch it would write instead.
const configLayer = Layer.succeed(Config.Service, {
  entries: () => Effect.succeed([]),
  changes: () => Stream.empty,
  update: (patch) =>
    Effect.sync(() => {
      patches.push(patch)
    }),
})

const it = testEffect(Layer.merge(PluginTestLayer, configLayer))
const sessionID = Session.ID.make("ses_mcp_forge_test")

const setup = Effect.gen(function* () {
  const tools = yield* Tool.Service
  // The forge also registers /forge-mcp; these tests exercise the tool only.
  yield* registerToolPlugin(McpForgeTool.Plugin, {
    command: {
      list: () => Effect.die("unused command.list"),
      transform: (callback) => {
        callback({ add: () => {} })
        return Effect.succeed({ dispose: Effect.void })
      },
      reload: () => Effect.void,
    },
  })
  yield* waitForTool(tools, "mcp_forge")
  return tools
})

const run = (tools: Tool.Interface, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: "mcp_forge", input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")

const designed = {
  action: "preview",
  source: "tools",
  name: "echo",
  description: "Echo server",
  tools: [
    {
      name: "say",
      description: "Echo the text back.",
      properties: { text: { type: "string" } },
      required: ["text"],
      run: { type: "exec", argv: ["echo", "{{text}}"] },
    },
  ],
}

describe("McpForgeTool", () => {
  it.effect("registers mcp_forge and lists the configured servers", () =>
    Effect.gen(function* () {
      const tools = yield* setup
      const listed = yield* run(tools, "list", { action: "list" })
      expect(listed.status).toBe("completed")
      expect(text(listed)).toContain("No MCP servers are configured.")
    }),
  )

  it.effect("previews a designed server and reports its problems", () =>
    Effect.gen(function* () {
      const tools = yield* setup
      const preview = yield* run(tools, "preview", designed)
      expect(preview.status).toBe("completed")
      expect(text(preview)).toContain("Server: echo — Echo server")
      expect(text(preview)).toContain("- say: Echo the text back.")
      expect(text(preview)).toContain("Ready to save.")
      expect(text(preview)).toContain("echo.mjs")

      const broken = yield* run(tools, "broken", { ...designed, tools: [{ ...designed.tools[0]!, required: ["missing"] }] })
      expect(broken.status).toBe("completed")
      expect(text(broken)).toContain("Problems:")
      expect(text(broken)).toContain("required argument \"missing\" is not declared")
      expect(text(broken)).toContain("Not ready to save")

      const badName = yield* run(tools, "bad-name", { ...designed, name: "Bad Name" })
      expect(badName.status).toBe("error")
      expect(badName.error?.message).toContain('Server name "Bad Name"')
    }),
  )

  it.effect("previews an OpenAPI document given as JSON text", () =>
    Effect.gen(function* () {
      const tools = yield* setup
      const preview = yield* run(tools, "openapi", {
        action: "preview",
        source: "openapi",
        name: "pets",
        baseUrl: "https://api.example.com",
        openapi: JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Pets" },
          paths: { "/pets": { get: { operationId: "listPets" } } },
        }),
      })
      expect(preview.status).toBe("completed")
      expect(text(preview)).toContain("Server: pets — Pets")
      expect(text(preview)).toContain("- listPets: GET /pets")
      expect(text(preview)).toContain("Ready to save.")
    }),
  )

  it.effect("registers an existing server config as it is", () =>
    Effect.gen(function* () {
      const tools = yield* setup
      patches.length = 0
      const preview = yield* run(tools, "server-preview", {
        action: "preview",
        name: "docs",
        server: { type: "remote", url: "https://docs.example.com/mcp" },
      })
      expect(text(preview)).toContain("registered as it is")
      expect(text(preview)).toContain('"type": "remote"')

      const saved = yield* run(tools, "server-save", {
        action: "save",
        name: "docs",
        server: { type: "remote", url: "https://docs.example.com/mcp" },
      })
      expect(saved.status).toBe("completed")
      expect(text(saved)).toContain("Registered docs")
      expect(patches.at(-1)?.mcpServers?.docs).toEqual({ type: "remote", url: "https://docs.example.com/mcp" })
    }),
  )

  it.effect("writes the generated module and registers it", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* setup
        patches.length = 0
        const target = path.join(directory, "echo.mjs")
        const saved = yield* run(tools, "save", { ...designed, action: "save", path: target })
        expect(saved.status).toBe("completed")
        expect(text(saved)).toContain(`Wrote ${target}.`)

        const source = yield* Effect.promise(() => Bun.file(target).text())
        expect(source).toContain('"name": "echo"')
        expect(source).toContain('"type": "exec"')
        expect(source).toContain('"name": "say"')

        expect(patches).toHaveLength(1)
        const server = patches[0]!.mcpServers!.echo
        expect(server?.type).toBe("local")
        expect(server?.type === "local" ? server.command[1] : undefined).toBe(target)

        const again = yield* run(tools, "save-again", { ...designed, action: "save", path: target })
        expect(again.status).toBe("error")
        expect(again.error?.message).toContain("already exists")
      }),
    ),
  )

  test("is registered in the internal pre list, the only place production loads it from", async () => {
    // A source check on purpose: deleting the line from `pre` leaves every other test green,
    // because they all register the plugin themselves.
    const source = await Bun.file(new URL("../src/plugin/internal.ts", import.meta.url)).text()
    const pre = /const pre = \[([\s\S]*?)\n\] as const/.exec(source)?.[1]

    expect(pre).not.toBeUndefined()
    expect(pre).toContain("McpForgeTool.Plugin")
    expect(source).toContain('import { McpForgeTool } from "../tool/plugin/mcp-forge.js"')
  })
})

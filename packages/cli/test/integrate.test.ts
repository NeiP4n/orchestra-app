import { describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { ProjectFilesIntegrations } from "@orchestra/core/project-files/files-integrations"
import { Commands } from "../src/commands/commands"
import { formatOutcome, loadManifestSpec, runIntegrate } from "../src/commands/handlers/integrate"
import integrateHandler from "../src/commands/handlers/integrate"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const fixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-integrate-"))
  await mkdir(path.join(dir, ".orchestra"), { recursive: true })
  return dir
}

const dispose = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true })

const exists = async (file: string): Promise<boolean> => access(file).then(
  () => true,
  () => false,
)

const restSpec = {
  apiVersion: "orchestra/v1",
  kind: "rest",
  name: "shop",
  description: "Shop catalog and orders.",
  when: "Use it to search products and prices and to create orders in the shop.",
  auth: { type: "api-key", credential: "shop-api-key", header: "X-Api-Key" },
  rest: { baseUrl: "https://api.shop.example.com/v1", openapi: "https://api.shop.example.com/openapi.json" },
}

const mcpSpec = {
  apiVersion: "orchestra/v1",
  kind: "mcp",
  name: "my-mcp",
  description: "Internal MCP server of the company.",
  when: "Use it to reach the company's internal data. Do not use it for the public web.",
  mcp: { url: "https://mcp.internal.example.com/mcp" },
}

describe("orchestra integrate wiring", () => {
  test("the integrate command and the integrations list subcommand are registered", () => {
    expect(Commands.commands.integrate).toBeDefined()
    expect(Commands.commands.integrations.commands.list).toBeDefined()
  })

  test("the real spec node dispatches argv to the real handler (dry-run)", async () => {
    const dir = await fixture()
    const previousCwd = process.cwd()
    const previousWrite = process.stdout.write.bind(process.stdout)
    let captured = ""
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const file = path.join(dir, "shop.yaml")
      await writeFile(file, Bun.YAML.stringify(restSpec), "utf8")
      process.chdir(dir)
      const command = Commands.commands.integrate.spec.pipe(Command.withHandler(integrateHandler))
      await Effect.runPromise(
        Command.runWith(command, { version: "test" })([file, "--dry-run"]).pipe(
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(captured).toContain('Manifest "shop" (rest) is valid — nothing installed')
      expect(await exists(path.join(dir, ".orchestra", "integrations"))).toBe(false)
    } finally {
      process.stdout.write = previousWrite
      process.chdir(previousCwd)
      await dispose(dir)
    }
  })
})

describe("loadManifestSpec", () => {
  test("reads a YAML manifest", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "shop.yaml")
      await writeFile(file, Bun.YAML.stringify(restSpec), "utf8")
      expect(await run(loadManifestSpec(file))).toMatchObject({ name: "shop", kind: "rest" })
    } finally {
      await dispose(dir)
    }
  })

  test("reads a JSON manifest", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "shop.json")
      await writeFile(file, JSON.stringify(restSpec), "utf8")
      expect(await run(loadManifestSpec(file))).toMatchObject({ name: "shop", kind: "rest" })
    } finally {
      await dispose(dir)
    }
  })

  test("a missing manifest file is a loud invalid error, not a crash", async () => {
    const dir = await fixture()
    try {
      await expect(run(loadManifestSpec(path.join(dir, "nope.yaml")))).rejects.toMatchObject({
        _tag: "ProjectFiles.Error",
        kind: "invalid",
      })
    } finally {
      await dispose(dir)
    }
  })
})

describe("runIntegrate", () => {
  test("installs a manifest and writes the mcp.yaml entry for an mcp kind", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "my-mcp.yaml")
      await writeFile(file, Bun.YAML.stringify(mcpSpec), "utf8")
      const outcome = await run(runIntegrate(dir, file))
      expect(outcome.installed).toBe(true)
      expect(outcome.name).toBe("my-mcp")
      expect(outcome.verified).toBe(true)
      expect(formatOutcome(outcome)).toContain('Installed "my-mcp" (mcp)')
      expect(await readFile(path.join(dir, ".orchestra", "integrations", "my-mcp.yaml"), "utf8")).toContain("my-mcp")
      const mcp = await run(ProjectFilesIntegrations.readMcp(dir))
      expect(mcp.servers["my-mcp"]?.url).toBe("https://mcp.internal.example.com/mcp")
      const installed = await run(ProjectFilesIntegrations.listIntegrations(dir))
      expect(installed.map((manifest) => manifest.name)).toContain("my-mcp")
    } finally {
      await dispose(dir)
    }
  })

  test("dry-run validates and writes nothing", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "shop.yaml")
      await writeFile(file, Bun.YAML.stringify(restSpec), "utf8")
      const outcome = await run(runIntegrate(dir, file, { dryRun: true }))
      expect(outcome.installed).toBe(false)
      expect(outcome.name).toBe("shop")
      expect(formatOutcome(outcome)).toContain("is valid — nothing installed")
      expect(await exists(path.join(dir, ".orchestra", "integrations"))).toBe(false)
      expect(await exists(path.join(dir, ".orchestra", "INTEGRATE.md"))).toBe(false)
    } finally {
      await dispose(dir)
    }
  })

  test("re-installing without force fails, with force overwrites", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "shop.yaml")
      await writeFile(file, Bun.YAML.stringify(restSpec), "utf8")
      await run(runIntegrate(dir, file))
      await expect(run(runIntegrate(dir, file))).rejects.toMatchObject({
        _tag: "ProjectFiles.Error",
        kind: "invalid",
      })
      const outcome = await run(runIntegrate(dir, file, { force: true }))
      expect(outcome.installed).toBe(true)
    } finally {
      await dispose(dir)
    }
  })

  test("a manifest with a secret value is rejected and nothing is written", async () => {
    const dir = await fixture()
    try {
      const file = path.join(dir, "bad.yaml")
      await writeFile(
        file,
        Bun.YAML.stringify({
          ...mcpSpec,
          name: "bad-mcp",
          mcp: { url: "https://mcp.internal.example.com/mcp", env: { API_KEY: "sk-live-123" } },
        }),
        "utf8",
      )
      await expect(run(runIntegrate(dir, file))).rejects.toMatchObject({
        _tag: "ProjectFiles.Error",
        kind: "invalid",
      })
      expect(await exists(path.join(dir, ".orchestra", "integrations"))).toBe(false)
    } finally {
      await dispose(dir)
    }
  })
})

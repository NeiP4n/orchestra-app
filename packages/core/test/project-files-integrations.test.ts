import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProjectFiles } from "@orchestra/core/project-files/index"
import { ProjectFilesIntegrations } from "@orchestra/core/project-files/files-integrations"

// Same pattern as the core test: the framework functions carry the
// Database.Service requirement, but no S3 syncer/restorer touches the
// database, so the cast is safe here.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E, never>)

const fixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-project-files-integrations-"))
  await mkdir(path.join(dir, ".orchestra"), { recursive: true })
  return dir
}

const write = async (dir: string, rel: string, contents: string): Promise<void> => {
  const file = path.join(dir, ".orchestra", rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

const writeSibling = async (dir: string, rel: string, contents: string): Promise<void> => {
  const file = path.join(dir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

const mcpSpec = {
  apiVersion: "orchestra/v1",
  kind: "mcp",
  name: "my-mcp",
  description: "Internal MCP server of the company.",
  when: "Use it to reach the company's internal data. Do not use it for the public web.",
  mcp: { url: "https://mcp.internal.example.com/mcp" },
}

const catalogSpec = {
  apiVersion: "orchestra/v1",
  kind: "catalog",
  name: "serena",
  description: "Semantic code intelligence at symbol level.",
  when: "Use it to find symbols and references across files before editing code.",
  catalog: { entry: "serena" },
}

const restSpec = {
  apiVersion: "orchestra/v1",
  kind: "rest",
  name: "shop",
  description: "Shop catalog and orders.",
  when: "Use it to search products and prices and to create orders in the shop.",
  auth: { type: "api-key", credential: "shop-api-key", header: "X-Api-Key" },
  rest: { baseUrl: "https://api.shop.example.com/v1", openapi: "https://api.shop.example.com/openapi.json" },
}

const providerSpec = {
  apiVersion: "orchestra/v1",
  kind: "provider",
  name: "llm-example",
  description: "Example LLM provider.",
  when: "Use fast-1 for drafts and routine work, smart-1 for hard tasks.",
  auth: { type: "api-key", credential: "llm-example-key" },
  provider: { baseUrl: "https://llm.example.com/v1", models: ["fast-1", "smart-1"], defaultModel: "fast-1" },
}

describe("ProjectFiles mcp.yaml", () => {
  test("round-trips a local and a remote server", async () => {
    const dir = await fixture()
    await run(
      ProjectFilesIntegrations.writeMcp(dir, {
        version: 1,
        servers: {
          local: { type: "local", command: ["npx", "-y", "@scope/mcp-server"], env: { LOG_LEVEL: "info" } },
          remote: { type: "remote", url: "https://mcp.example.com/mcp", credential: "mcp-key" },
        },
      }),
    )
    const back = await run(ProjectFilesIntegrations.readMcp(dir))
    expect(back.servers.local?.type).toBe("local")
    expect(back.servers.remote?.url).toBe("https://mcp.example.com/mcp")
    expect(back.servers.remote?.credential).toBe("mcp-key")
  })

  test("secret values under innocent field names and command arguments are rejected without echo or overwrite", async () => {
    const dir = await fixture()
    const safe = {
      version: 1,
      servers: {
        good: {
          type: "local",
          command: ["npx", "x"],
          env: { MODE: "production", API_KEY: { credential: "vault-project-key" } },
        },
      },
    }
    await run(ProjectFilesIntegrations.writeMcp(dir, safe))
    const previous = await readFile(path.join(dir, ".orchestra", "mcp.yaml"), "utf8")
    const secret = "sk-proj-NEVER-PRINT-THIS-KEY-12345678"
    for (const server of [
      { type: "local", command: ["npx", "x"], env: { CUSTOM: secret } },
      { type: "remote", url: "https://example.invalid/mcp", headers: { "X-Custom": secret } },
      { type: "local", command: ["tool", secret] },
      { type: "local", command: ["tool", "--password", "opaque-value"] },
      { type: "remote", url: "https://example.invalid/mcp?token=opaque-value" },
      { type: "remote", url: "https://user:opaque-value@example.invalid/mcp" },
      { type: "remote", url: "https://example.invalid/mcp", credential: secret },
    ]) {
      const error = await run(ProjectFilesIntegrations.writeMcp(dir, { version: 1, servers: { bad: server } })).then(
        () => undefined,
        (error) => error,
      )
      expect(error).toMatchObject({ _tag: "ProjectFiles.Error", kind: "invalid" })
      expect(String(error)).not.toContain(secret)
      expect(await readFile(path.join(dir, ".orchestra", "mcp.yaml"), "utf8")).toBe(previous)
    }
  })

  test("a missing file is a loud missing error, not an empty file", async () => {
    const dir = await fixture()
    await expect(run(ProjectFilesIntegrations.readMcp(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "missing",
    })
  })

  test("a corrupt file fails loudly", async () => {
    const dir = await fixture()
    await write(dir, "mcp.yaml", "servers: [broken\n")
    await expect(run(ProjectFilesIntegrations.readMcp(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "corrupt",
    })
  })

  test("a secret VALUE in env is rejected loudly, a credential reference is not", async () => {
    const dir = await fixture()
    await expect(
      run(
        ProjectFilesIntegrations.writeMcp(dir, {
          version: 1,
          servers: { bad: { type: "local", command: ["npx", "x"], env: { API_KEY: "sk-live-123" } } },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProjectFiles.Error", kind: "invalid" })
    await run(
      ProjectFilesIntegrations.writeMcp(dir, {
        version: 1,
        servers: { good: { type: "local", command: ["npx", "x"], env: { API_KEY: { credential: "mcp-key" } } } },
      }),
    )
    const back = await run(ProjectFilesIntegrations.readMcp(dir))
    expect(back.servers.good?.env?.API_KEY).toEqual({ credential: "mcp-key" })
  })

  test("a local server without a command and a timeout above the cap are rejected", async () => {
    const dir = await fixture()
    await expect(
      run(
        ProjectFilesIntegrations.writeMcp(dir, {
          version: 1,
          servers: { bad: { type: "local", command: [] } },
        }),
      ),
    ).rejects.toMatchObject({ kind: "invalid" })
    await expect(
      run(
        ProjectFilesIntegrations.writeMcp(dir, {
          version: 1,
          servers: { bad: { type: "remote", url: "https://mcp.example.com/mcp", timeoutMs: 43_200_000 } },
        }),
      ),
    ).rejects.toMatchObject({ kind: "invalid" })
  })
})

describe("ProjectFiles integrate", () => {
  test("installs an MCP integration end to end: manifest, mcp.yaml entry, INTEGRATE.md, verified report", async () => {
    const dir = await fixture()
    const report = await run(ProjectFilesIntegrations.integrate(dir, mcpSpec))
    expect(report).toMatchObject({ name: "my-mcp", type: "mcp", status: "installed", verified: true })
    expect(report.manifest).toBe("integrations/my-mcp.yaml")
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    const manifest = await readFile(path.join(dir, ".orchestra", "integrations", "my-mcp.yaml"), "utf8")
    expect(manifest).toContain("my-mcp")
    const mcp = await run(ProjectFilesIntegrations.readMcp(dir))
    expect(mcp.servers["my-mcp"]?.url).toBe("https://mcp.internal.example.com/mcp")
    const doc = await readFile(path.join(dir, ".orchestra", "INTEGRATE.md"), "utf8")
    expect(doc).toContain("my-mcp")
    expect(doc).toContain("Never in a file")
  })

  test("installs a catalog entry end to end: the server comes from the MCP catalog", async () => {
    const dir = await fixture()
    const report = await run(ProjectFilesIntegrations.integrate(dir, catalogSpec))
    expect(report).toMatchObject({ name: "serena", type: "catalog", status: "installed", verified: true })
    const mcp = await run(ProjectFilesIntegrations.readMcp(dir))
    expect(mcp.servers.serena?.type).toBe("local")
    const command = (mcp.servers.serena as { command?: ReadonlyArray<string> }).command ?? []
    expect(command[0]).toBe("uvx")
    const doc = await readFile(path.join(dir, ".orchestra", "INTEGRATE.md"), "utf8")
    expect(doc).toContain("| serena | catalog |")
  })

  test("installs REST and provider integrations: manifest written, verified, no mcp.yaml touched", async () => {
    const dir = await fixture()
    const rest = await run(ProjectFilesIntegrations.integrate(dir, restSpec))
    expect(rest).toMatchObject({ name: "shop", type: "rest", status: "installed", verified: true })
    const provider = await run(ProjectFilesIntegrations.integrate(dir, providerSpec))
    expect(provider).toMatchObject({ name: "llm-example", type: "provider", status: "installed", verified: true })
    await expect(run(ProjectFilesIntegrations.readMcp(dir))).rejects.toMatchObject({ kind: "missing" })
    const listed = await run(ProjectFilesIntegrations.listIntegrations(dir))
    expect(listed.map((entry) => entry.name)).toEqual(["llm-example", "shop"])
  })

  test("rejects a secret value, a bad name, a short when, an unknown catalog entry, and a duplicate without force", async () => {
    const dir = await fixture()
    await expect(
      run(
        ProjectFilesIntegrations.integrate(dir, {
          ...mcpSpec,
          name: "leaky",
          mcp: { command: ["npx", "x"], env: { TOKEN: "secret-value" } },
        }),
      ),
    ).rejects.toMatchObject({ kind: "invalid" })
    await expect(run(ProjectFilesIntegrations.integrate(dir, { ...mcpSpec, name: "Bad_Name" }))).rejects.toMatchObject({
      kind: "invalid",
    })
    await expect(run(ProjectFilesIntegrations.integrate(dir, { ...mcpSpec, when: "too short" }))).rejects.toMatchObject(
      {
        kind: "invalid",
      },
    )
    await expect(
      run(ProjectFilesIntegrations.integrate(dir, { ...catalogSpec, catalog: { entry: "no-such-server" } })),
    ).rejects.toMatchObject({ kind: "invalid" })
    await expect(
      run(
        ProjectFilesIntegrations.integrate(dir, {
          ...restSpec,
          rest: { baseUrl: "https://user:pass@api.shop.example.com/v1" },
        }),
      ),
    ).rejects.toMatchObject({ kind: "invalid" })
    await run(ProjectFilesIntegrations.integrate(dir, mcpSpec))
    await expect(run(ProjectFilesIntegrations.integrate(dir, mcpSpec))).rejects.toMatchObject({ kind: "invalid" })
    const forced = await run(ProjectFilesIntegrations.integrate(dir, mcpSpec, { force: true }))
    expect(forced.status).toBe("installed")
  })
})

describe("ProjectFiles skills.json", () => {
  test("a healthy registry loads, a missing one is empty, a damaged one is a divergence — never silent-empty", async () => {
    const dir = await fixture()
    expect(await run(ProjectFilesIntegrations.checkSkillRegistry(dir))).toEqual([])
    await writeSibling(dir, "native-skills/skills.json", JSON.stringify({ version: 1, skills: [] }))
    expect(await run(ProjectFilesIntegrations.checkSkillRegistry(dir))).toEqual([])
    await writeSibling(dir, "native-skills/skills.json", "{not json\n")
    const divergences = await run(ProjectFilesIntegrations.checkSkillRegistry(dir))
    expect(divergences.length).toBe(1)
    expect(divergences[0]?.path).toBe("native-skills/skills.json")
    expect(divergences[0]?.detail).toContain("damaged")
    await writeSibling(dir, "native-skills/skills.json", JSON.stringify({ version: 2, skills: [] }))
    const wrongVersion = await run(ProjectFilesIntegrations.checkSkillRegistry(dir))
    expect(wrongVersion.length).toBe(1)
    expect(wrongVersion[0]?.detail).toContain("damaged")
  })

  test("a damaged registry shows up in health.json as divergent", async () => {
    const dir = await fixture()
    await writeSibling(dir, "native-skills/skills.json", "{not json\n")
    const divergences = await run(ProjectFilesIntegrations.checkSkillRegistry(dir))
    const report = await run(ProjectFiles.ProjectFilesHealth.checkHealth(dir, divergences))
    const entry = report.files.find((file) => file.path === "native-skills/skills.json")
    expect(entry?.status).toBe("divergent")
    expect(entry?.detail).toContain("damaged")
    expect(report.status).toBe("degraded")
  })

  test("the registry path is a sibling of .orchestra, not inside it", async () => {
    const dir = await fixture()
    expect(ProjectFilesIntegrations.skillRegistryPath(dir)).toBe(path.join(dir, "native-skills", "skills.json"))
  })
})

describe("ProjectFiles integrations registry", () => {
  test("mcp.yaml, integrations/ and INTEGRATE.md are git-tracked with .gitignore lines", async () => {
    const tracked = ProjectFiles.ProjectFilesRegistry.gitTrackedRels()
    expect(tracked).toContain("mcp.yaml")
    expect(tracked).toContain("integrations/")
    expect(tracked).toContain("INTEGRATE.md")
    // Line endings follow the checkout (CRLF on Windows), so the file is
    // normalized before the per-line membership check.
    const gitignore = (await readFile(path.join(import.meta.dir, "..", "..", "..", ".gitignore"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    )
    for (const line of ProjectFiles.ProjectFilesRegistry.gitignoreLines()) {
      expect(gitignore).toContain(`${line}\n`)
    }
  })

  test("the index lists notes/, plots/, command/ and playtest/ files", async () => {
    const dir = await fixture()
    await write(dir, "notes/plan.md", "# plan\n")
    await write(dir, "plots/chart.svg", "<svg/>\n")
    await write(dir, "command/deploy.md", "# deploy\n")
    await write(dir, "playtest/session-1.md", "# playtest\n")
    await write(dir, "mcp.yaml", "version: 1\nservers: {}\n")
    await write(dir, "integrations/shop.yaml", "apiVersion: orchestra/v1\nkind: rest\nname: shop\n")
    const index = await run(ProjectFiles.ProjectFilesIndex.refreshIndex(dir))
    const paths = index.entries.map((entry) => entry.path)
    for (const expected of ["notes/plan.md", "plots/chart.svg", "command/deploy.md", "playtest/session-1.md"]) {
      expect(paths).toContain(expected)
    }
    expect(paths).toContain("mcp.yaml")
    expect(paths).toContain("integrations/shop.yaml")
  })

  test("syncAll runs the S3 syncers: valid mcp.yaml ok, INTEGRATE.md regenerated, damaged registry failed", async () => {
    const dir = await fixture()
    await run(ProjectFilesIntegrations.integrate(dir, restSpec))
    await writeSibling(dir, "native-skills/skills.json", "{not json\n")
    const report = await run(ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never }))
    const byFile = new Map(report.files.map((entry) => [entry.file, entry.status]))
    expect(byFile.get("mcp.yaml")).toBe("ok")
    expect(byFile.get("INTEGRATE.md")).toBe("ok")
    expect(byFile.get("native-skills/skills.json")).toBe("failed")
    const doc = await readFile(path.join(dir, ".orchestra", "INTEGRATE.md"), "utf8")
    expect(doc).toContain("| shop | rest |")
  })

  test("restoreFromFiles: mcp.yaml and skills.json skipped when valid, INTEGRATE.md regenerated", async () => {
    const dir = await fixture()
    await run(ProjectFilesIntegrations.integrate(dir, restSpec))
    await writeSibling(dir, "native-skills/skills.json", JSON.stringify({ version: 1, skills: [] }))
    const report = await run(ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv: undefined as never }))
    const byFile = new Map(report.entries.map((entry) => [entry.file, entry.status]))
    expect(byFile.get("native-skills/skills.json")).toBe("skipped")
    expect(byFile.get("INTEGRATE.md")).toBe("restored")
    const doc = await readFile(path.join(dir, ".orchestra", "INTEGRATE.md"), "utf8")
    expect(doc).toContain("| shop | rest |")
  })

  test("restoreFromFiles reports a damaged skill registry as failed, not skipped", async () => {
    const dir = await fixture()
    await writeSibling(dir, "native-skills/skills.json", "{not json\n")
    const report = await run(ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv: undefined as never }))
    const entry = report.entries.find((item) => item.file === "native-skills/skills.json")
    expect(entry?.status).toBe("failed")
    expect(entry?.error).toContain("damaged")
  })
})

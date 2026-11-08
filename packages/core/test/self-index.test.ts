import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { collect, commandDocs, configDocs, customDocs, markdownDocs, toolDocs } from "@orchestra/core/self/sources"
import { count, open, readMeta, replaceAll, search, writeMeta } from "@orchestra/core/self/store"
import type { SelfDoc } from "@orchestra/core/self/sources"

const tmpdirs: string[] = []

const tmpdir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-index-"))
  tmpdirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const fixtureRoot = (files: Record<string, string>) => {
  const root = tmpdir()
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

describe("self index collectors", () => {
  test("commandDocs reads nested Spec.make commands with their parent prefix", () => {
    const root = fixtureRoot({
      "packages/cli/src/commands/commands.ts": [
        'const Root = Spec.make("orchestra", {',
        '  description: "Orchestra command line interface",',
        "  commands: [",
        '    Spec.make("plugin", {',
        '      description: "Manage plugins",',
        "      commands: [",
        '        Spec.make("add", {',
        '          description: "Add a plugin",',
        "        }),",
        "      ],",
        "    }),",
        "  ],",
        "})",
      ].join("\n"),
    })
    const names = commandDocs(root).map((doc) => doc.title)
    expect(names).toEqual(["orchestra", "orchestra plugin", "orchestra plugin add"])
  })

  test("configDocs reads Config.Info fields with their descriptions", () => {
    const root = fixtureRoot({
      "packages/schema/src/config.ts": [
        'export class Info extends Schema.Class<Info>("Config.Info")({',
        "  shell: Schema.String.pipe(optional).annotate({",
        '    description: "Default shell to use for terminal and shell tool execution",',
        "  }),",
        "  self_index: ConfigSelfIndex.Info.pipe(optional).annotate({",
        '    description: "The agent\'s index of Orchestra itself",',
        "  }),",
        "}) {}",
      ].join("\n"),
    })
    const docs = configDocs(root)
    const shell = docs.find((doc) => doc.id === "config:shell")
    expect(shell?.body).toContain("Default shell")
    expect(docs.find((doc) => doc.id === "config:self_index")?.body).toContain("index of Orchestra itself")
  })

  test("toolDocs reads built-in tool plugin names and full descriptions", () => {
    const root = fixtureRoot({
      "packages/core/src/tool/plugin/example.ts": [
        'export const name = "example"',
        "export const description = [",
        '  "Do example things with the project.",',
        '  "Second line.",',
        "].join('\\n')",
      ].join("\n"),
    })
    const docs = toolDocs(root)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.id).toBe("tool:example")
    expect(docs[0]!.body).toBe("Do example things with the project.\nSecond line.")
  })

  test("markdownDocs splits a document into one document per section", () => {
    const root = fixtureRoot({
      "AI_ATLAS.md": ["# Atlas", "", "intro text", "", "## Alpha", "", "about alpha", "", "## Beta", "", "about beta"].join(
        "\n",
      ),
    })
    const docs = markdownDocs(root)
    expect(docs.map((doc) => doc.title)).toEqual([
      "AI_ATLAS.md — overview",
      "AI_ATLAS.md — Alpha",
      "AI_ATLAS.md — Beta",
    ])
  })

  test("customDocs indexes the operator's own files and skips missing ones", () => {
    const root = tmpdir()
    const file = path.join(root, "notes.md")
    fs.writeFileSync(file, "# Notes\n\n## Deploy\n\nhow we deploy")
    const docs = customDocs([file, path.join(root, "missing.md")])
    expect(docs).toHaveLength(2)
    expect(docs.every((doc) => doc.kind === "custom")).toBe(true)
  })

  test("collect always includes env docs and extension points, even without a source tree", () => {
    const root = tmpdir()
    const docs = collect(root)
    expect(docs.some((doc) => doc.kind === "env" && doc.id === "env:ORCHESTRA_VERSION")).toBe(true)
    expect(docs.some((doc) => doc.kind === "extension" && doc.id === "extension:mcp")).toBe(true)
  })

  test("collect never emits duplicate ids", () => {
    const root = fixtureRoot({
      "AI_ATLAS.md": ["# Atlas", "", "## Alpha", "", "one", "", "## Alpha", "", "two"].join("\n"),
    })
    const docs = collect(root)
    const ids = docs.map((doc) => doc.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("self index store", () => {
  const docs: SelfDoc[] = [
    { id: "config:model", kind: "config", title: "model", body: "Default model to use when no session or agent model is selected" },
    { id: "command:serve", kind: "command", title: "orchestra serve", body: "Start the headless server" },
    { id: "env:ORCHESTRA_UPDATE_URL", kind: "env", title: "ORCHESTRA_UPDATE_URL", body: "Update-service URL for upgrades" },
  ]

  test("replaceAll stores documents and search ranks the wording match first", () => {
    const store = open(tmpdir())
    try {
      expect(replaceAll(store, docs)).toBe(3)
      expect(count(store)).toBe(3)
      const hits = search(store, "default model selection")
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.id).toBe("config:model")
    } finally {
      store.db.close()
    }
  })

  test("search answers with a snippet and a kind for a command question", () => {
    const store = open(tmpdir())
    try {
      replaceAll(store, docs)
      const hits = search(store, "start server")
      const serve = hits.find((hit) => hit.id === "command:serve")
      expect(serve?.kind).toBe("command")
      expect(serve?.snippet).toContain("headless server")
    } finally {
      store.db.close()
    }
  })

  test("an exact identifier question ranks the registry document first", () => {
    const store = open(tmpdir())
    try {
      replaceAll(store, [
        ...docs,
        {
          id: "doc:guide#models",
          kind: "doc",
          title: "Notes about models",
          body: "The default model and the session model and the agent model, model model model, all the default models.",
        },
      ])
      const hits = search(store, "model")
      expect(hits[0]!.id).toBe("config:model")
    } finally {
      store.db.close()
    }
  })

  test("meta survives a rebuild for fingerprint comparison", () => {
    const store = open(tmpdir())
    try {
      replaceAll(store, docs)
      writeMeta(store, "fingerprint", "abc")
      expect(readMeta(store, "fingerprint")).toBe("abc")
      replaceAll(store, docs.slice(0, 1))
      expect(count(store)).toBe(1)
      expect(readMeta(store, "fingerprint")).toBe("abc")
    } finally {
      store.db.close()
    }
  })
})

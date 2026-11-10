import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Orchestra } from "@orchestra/schema/orchestra"
import { ProjectTemplateV2Reader as Reader } from "../src/project-template-v2-reader"
import { ProjectTemplateV2Library as Library } from "../src/project-template-v2-library"
import { processFixture } from "./project-template-v2.test"

test("passive live reader captures owned metadata, model snapshots and actual skill bytes into disk library", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-reader-"))
  try {
    await writeFile(path.join(root, "SKILL.md"), "# Offer skill\nCheck the request first.\n")
    const values = new Map<string, unknown>([["orchestra/project/prj_a", { id: "prj_a", name: "Factory", directory: root, main: "ses_main", created: 1 }], ["orchestra/owner/ses_main", "prj_a"], ["rules/project:prj_a", [{ id: "rule", text: "Ask before publishing.", by: "operator", at: 1 }]]])
    const info = { id: "ses_main", title: "Main", agent: "orchestrator", location: { directory: root }, metadata: { [Orchestra.SessionModelsMetadataKey]: [{ providerID: "demo", id: "backup", variant: "careful" }] } }
    const stores: Reader.Stores = {
      kv: { get: key => Effect.succeed(values.get(key)), scan: ({ prefix }) => Effect.succeed({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
      getSession: () => Effect.succeed(info), listSessionsInTree: () => Effect.succeed([info]),
      roles: async () => processFixture().process.roles, playbook: async () => ({ text: "Review requests and prepare offers.", recommendedRoles: ["team-seller"] }),
      programs: async () => [{ id: "git", reason: "Review changes." }],
      skills: async () => ({ definitions: [{ id: "offers", name: "Offers", entry: "SKILL.md", root, files: ["SKILL.md"], dependencies: [] }], assignments: [{ target: { kind: "session", sessionID: "ses_main" }, skills: ["offers"] }] }),
    }
    const linked = { browsers: [], vault: [], selectedGlobalSlotIDs: new Set<string>(), providers: [], mcp: [] }
    const meta = { name: "Factory", description: "Reusable process", minOrchestraVersion: "1.0.0" }
    const p = await Reader.capture(stores, "prj_a", meta, linked)
    expect(p.bundle.process.sessionModels).toEqual([{ session: "session_1", models: [{ provider: "demo", id: "backup", variant: "careful" }] }])
    expect(p.bundle.process.skillAssignments).toEqual([{ target: { kind: "session", session: "session_1" }, skills: ["offers"] }])
    expect(p.bundle.process.skills[0].files[0].content).toBe("# Offer skill\nCheck the request first.\n")
    expect(p.text).not.toContain(root)
    await Library.local(root).saveSerialized(p.text, "factory", p.digest)
    expect(await Library.local(root).preview("factory")).toEqual(p)
    let reads = 0
    const changing = { ...stores, playbook: async () => ({ text: ++reads === 1 ? "Before" : "After", recommendedRoles: [] }) }
    await expect(Reader.capture(changing, "prj_a", meta, linked)).rejects.toThrow("changed during capture")
    Object.assign(info.metadata, { [Orchestra.SessionModelsMetadataKey]: [{ invalid: true }] })
    await expect(Reader.capture(stores, "prj_a", meta, linked)).rejects.toThrow("metadata is damaged")
  } finally { await rm(root, { recursive: true, force: true }) }
})

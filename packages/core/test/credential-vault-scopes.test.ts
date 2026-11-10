import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { CredentialVault } from "../src/credential-vault/index"
import { VaultAccess } from "../src/credential-vault/access"
async function fixture(
  run: (f: {
    root: string
    a: ReturnType<typeof CredentialVault.make>
    b: ReturnType<typeof CredentialVault.make>
    admin: ReturnType<typeof CredentialVault.make>
    calls: () => number
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-scopes-"))
  let calls = 0
  const common = {
    directory: root,
    collector: {
      collect: async (initial?: { name: string; site: string }) => ({
        name: initial?.name || "service",
        site: "https://example.invalid/v1",
        blob: "U0VBTEVE",
        backend: "windows-dpapi-user-v1" as const,
      }),
    },
    checkUrl: async () => {},
    request: async () => {
      calls++
      return { status: 200, durationMs: 1 }
    },
  }
  try {
    await run({
      root,
      a: CredentialVault.make({ ...common, projectID: "prj_a" }),
      b: CredentialVault.make({ ...common, projectID: "prj_b" }),
      admin: CredentialVault.make(common),
      calls: () => calls,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test("explicit local is visible only to its project; global usable across projects without upgrading legacy entries", () =>
  fixture(async ({ a, b, admin }) => {
    await a.writeFromOperator(undefined, undefined, undefined, {
      name: "local",
      site: "https://example.invalid",
      scope: "project",
    })
    await admin.writeFromOperator(undefined, undefined, undefined, {
      name: "global",
      site: "https://example.invalid",
      scope: "global",
    })
    await admin.writeFromOperator(undefined, undefined, undefined, { name: "legacy", site: "https://example.invalid" })
    expect((await a.list()).map((v) => v.name)).toEqual(["local", "global"])
    expect((await b.list()).map((v) => v.name)).toEqual(["global"])
    const local = (await a.list())[0]
    await expect(a.bindFromOperator(local.id, "prj_b")).rejects.toThrow("cannot be shared")
    await expect(b.deleteFromOperator(local.id, true)).rejects.toThrow("unavailable")
  }))
test("empty template slots have no value and no grants; fill preserves identity and remains denied until explicit allow", () =>
  fixture(async ({ root, a, calls }) => {
    const [slot] = await a.createEmptyLocalSlotsFromOperator([{ name: "service", type: "api-key", label: "Service" }])
    expect(slot.state).toBe("empty")
    expect(slot.allowedSessionIDs).toEqual([])
    const scope = { sessionID: "ses_main", projectID: "prj_a", directory: root }
    VaultAccess.set(scope, true)
    try {
      await expect(a.checkHttp("service", "https://example.invalid/v1/models", scope)).rejects.toThrow("empty")
      const filled = await a.writeFromOperator(slot.id)
      expect(filled?.id).toBe(slot.id)
      expect((await a.slots())[0].state).toBe("filled")
      await expect(a.checkHttp("service", "https://example.invalid/v1/models", scope)).rejects.toThrow("not allowed")
      await a.setAllowedSessionsFromOperator(slot.id, ["ses_main"], true)
      expect(await a.checkHttp("service", "https://example.invalid/v1/models", scope)).toEqual({
        status: 200,
        durationMs: 1,
      })
      expect(calls()).toBe(1)
      await a.setAllowedSessionsFromOperator(slot.id, [], true)
      await expect(a.checkHttp("service", "https://example.invalid/v1/models", scope)).rejects.toThrow("not allowed")
      const log = await readFile(path.join(root, "usage.jsonl"), "utf8")
      expect(log).not.toContain("U0VBTEVE")
      expect(log).not.toContain("example.invalid")
      expect(log).toContain('"outcome":"success"')
      expect(log).toContain('"outcome":"denied"')
    } finally {
      VaultAccess.set(scope, false)
    }
  }))
test("global availability never bypasses exact chat grant, saved site or explicit session allowlist", () =>
  fixture(async ({ root, a, b, admin, calls }) => {
    const entry = (await admin.writeFromOperator(undefined, undefined, undefined, {
      name: "global",
      site: "https://example.invalid",
      scope: "global",
    }))!
    await admin.setAllowedSessionsFromOperator(entry.id, ["ses_b"], true)
    const scope = { sessionID: "ses_b", projectID: "prj_b", directory: root }
    await expect(b.checkHttp("global", "https://example.invalid/v1/models", scope)).rejects.toThrow("OFF")
    VaultAccess.set(scope, true)
    try {
      expect(await b.checkHttp("global", "https://example.invalid/v1/models", scope)).toEqual({
        status: 200,
        durationMs: 1,
      })
      await expect(a.checkHttp("global", "https://example.invalid/v1/models", scope)).rejects.toThrow("mismatch")
      await expect(b.checkHttp("global", "https://other.invalid/v1/models", scope)).rejects.toThrow()
      expect(calls()).toBe(1)
    } finally {
      VaultAccess.set(scope, false)
    }
  }))
test("project cleanup deletes only its local slots, preserves globals and other project slots", () =>
  fixture(async ({ a, b, admin }) => {
    await a.createEmptyLocalSlotsFromOperator([{ name: "service", type: "login", label: "A" }])
    await b.createEmptyLocalSlotsFromOperator([{ name: "service", type: "login", label: "B" }])
    await admin.writeFromOperator(undefined, undefined, undefined, {
      name: "global",
      site: "https://example.invalid",
      scope: "global",
    })
    await a.removeProjectSlots("prj_a")
    expect((await a.slots()).map((v) => v.scope)).toEqual(["global"])
    expect((await b.slots()).map((v) => v.scope)).toEqual(["project", "global"])
  }))
test("empty slot import is atomic and create-only, extra value fields rejected", () =>
  fixture(async ({ a }) => {
    await a.createEmptyLocalSlotsFromOperator([{ name: "one", type: "login", label: "One" }])
    await expect(
      a.createEmptyLocalSlotsFromOperator([
        { name: "two", type: "login", label: "Two" },
        { name: "one", type: "login", label: "One" },
      ]),
    ).rejects.toThrow("Nothing was replaced")
    expect((await a.slots()).map((v) => v.name)).toEqual(["one"])
    await expect(
      a.createEmptyLocalSlotsFromOperator([{ name: "two", type: "login", label: "Two", value: "PRIVATE" } as never]),
    ).rejects.toThrow("Invalid")
    await expect(a.setAllowedSessionsFromOperator((await a.slots())[0].id, ["ses_main"], false)).rejects.toThrow(
      "explicit",
    )
  }))
test("scope corruption blocks reads without leaking or rewriting ciphertext", () =>
  fixture(async ({ root, a }) => {
    await writeFile(
      path.join(root, "registry.json"),
      JSON.stringify([{ scope: "global", projectID: "prj_a", blob: "U0VBTEVE" }]),
    )
    await expect(a.slots()).rejects.toThrow("damaged")
  }))
test("audit link cannot redirect slot usage to an unrelated file", () =>
  fixture(async ({ root, a }) => {
    const entry = (await a.writeFromOperator(undefined, undefined, undefined, {
      name: "service",
      site: "https://example.invalid",
      scope: "project",
    }))!
    await a.setAllowedSessionsFromOperator(entry.id, ["ses_main"], true)
    const outside = path.join(root, "outside")
    await writeFile(outside, "UNCHANGED")
    await symlink(outside, path.join(root, "usage.jsonl"))
    const scope = { sessionID: "ses_main", projectID: "prj_a", directory: root }
    VaultAccess.set(scope, true)
    try {
      await expect(a.checkHttp("service", "https://example.invalid/v1/models", scope)).rejects.toThrow("regular")
      expect(await readFile(outside, "utf8")).toBe("UNCHANGED")
    } finally {
      VaultAccess.set(scope, false)
    }
  }))
test("import recovery reuses exact reserved empty IDs and never resets filled or granted slots", () =>
  fixture(async ({ a, b, root }) => {
    const slots = [{ id: "slot_one", name: "one", type: "login" as const, label: "One" }]
    const first = await a.ensureImportedEmptySlotsFromOperator("pti_test", slots)
    const second = await a.ensureImportedEmptySlotsFromOperator("pti_test", slots)
    expect(first).toEqual(second)
    expect(await a.slots()).toHaveLength(1)
    expect(first[0].allowedSessionIDs).toEqual([])
    expect(first[0].state).toBe("empty")
    await expect(b.ensureImportedEmptySlotsFromOperator("pti_test", slots)).rejects.toThrow("another operation")
    await expect(a.ensureImportedEmptySlotsFromOperator("pti_other", slots)).rejects.toThrow("another operation")
    await a.writeFromOperator("slot_one")
    await expect(a.ensureImportedEmptySlotsFromOperator("pti_test", slots)).rejects.toThrow("changed")
    const before = await readFile(path.join(root, "registry.json"), "utf8")
    await expect(
      a.ensureImportedEmptySlotsFromOperator("pti_test", [{ id: "other", name: "one", type: "login", label: "One" }]),
    ).rejects.toThrow("replace")
    expect(await readFile(path.join(root, "registry.json"), "utf8")).toBe(before)
  }))
test("import ensure is atomic on conflicts and rejects unrecognized fields or duplicate identities", () =>
  fixture(async ({ a, root }) => {
    await a.createEmptyLocalSlotsFromOperator([{ name: "taken", type: "login", label: "Taken" }])
    const before = await readFile(path.join(root, "registry.json"), "utf8")
    await expect(
      a.ensureImportedEmptySlotsFromOperator("pti_test", [
        { id: "slot_one", name: "new", type: "login", label: "New" },
        { id: "slot_two", name: "taken", type: "login", label: "Taken" },
      ]),
    ).rejects.toThrow()
    expect(await readFile(path.join(root, "registry.json"), "utf8")).toBe(before)
    await expect(
      a.ensureImportedEmptySlotsFromOperator("pti_test", [
        { id: "slot_one", name: "new", type: "login", label: "New", value: "PRIVATE" } as never,
      ]),
    ).rejects.toThrow()
    await expect(
      a.ensureImportedEmptySlotsFromOperator("pti_test", [
        { id: "slot_one", name: "one", type: "login", label: "One" },
        { id: "slot_one", name: "two", type: "login", label: "Two" },
      ]),
    ).rejects.toThrow()
  }))

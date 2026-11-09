import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { CredentialVault } from "@orchestra/core/credential-vault/index"
import { collector, SCRIPT } from "@orchestra/core/credential-vault/windows"

test("operator collector returns ciphertext only; registry list returns names only and variables remain stable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-fake-"))
  let blob = "RkFLRS1DSVBIRVJURVhU"
  const access = CredentialVault.make({ directory, collector: { collect: async () => ({ name: "Work", site: "https://example.invalid", backend: "windows-dpapi-user-v1", blob }) } })
  try {
    const first = (await access.writeFromOperator())!
    expect(first.variables.password).toMatch(/^ORCH_SECRET_WORK_[A-F0-9]{12}_PASSWORD$/)
    expect(first).not.toHaveProperty("blob")
    expect(await access.list()).toEqual([{ id: first.id, name: "Work" }])
    const disk = await readFile(path.join(directory, "registry.json"), "utf8")
    expect(disk).toContain(blob)
    expect(disk).not.toContain("fake-password-not-for-storage")
    blob = "TkVXLUZBS0UtQkxPQg=="
    const replaced = (await access.writeFromOperator(first.id))!
    expect(replaced.variables).toEqual(first.variables)
    expect(await access.list()).toHaveLength(1)
    await expect(access.deleteFromOperator(first.id, false)).rejects.toThrow("confirmation")
    expect(await access.list()).toHaveLength(1)
    await access.deleteFromOperator(first.id, true)
    expect(await access.list()).toEqual([])
    expect(access).not.toHaveProperty("get")
    expect(access).not.toHaveProperty("decrypt")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test("cancelled secure input leaves no entry and unsupported OS never falls back to plaintext", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-cancel-"))
  try {
    const access = CredentialVault.make({ directory, collector: { collect: async () => undefined } })
    expect(await access.writeFromOperator()).toBeUndefined()
    expect(await access.list()).toEqual([])
    await expect(collector("linux").collect()).rejects.toThrow("No plaintext fallback")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test("corrupt registry fails closed and cannot be replaced on update", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-corrupt-"))
  const file = path.join(directory, "registry.json")
  try {
    await writeFile(file, "{corrupt")
    const access = CredentialVault.make({ directory, collector: { collect: async () => { throw new Error("must not collect") } } })
    await expect(access.writeFromOperator("missing")).rejects.toThrow("damaged")
    await expect(access.list()).rejects.toThrow("damaged")
    expect(await readFile(file, "utf8")).toBe("{corrupt")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test("native form masks login and password and protects before returning output; no decrypt script", () => {
  expect(SCRIPT).toContain("UseSystemPasswordChar = $true")
  expect(SCRIPT).toContain("ProtectedData]::Protect")
  expect(SCRIPT).toContain("DataProtectionScope]::CurrentUser")
  expect(SCRIPT).not.toContain("::Unprotect")
  expect(SCRIPT).not.toContain("Write-Host")
  expect(SCRIPT).toContain("[Array]::Clear")
})

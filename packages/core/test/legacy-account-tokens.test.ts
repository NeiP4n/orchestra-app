import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { CredentialEncryption } from "@orchestra/core/credential/encryption"
import { Database } from "@orchestra/core/database/database"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "./fixture/tmpdir"

// A3-04: legacy `account` / `control_account` OAuth tokens must not sit in
// plaintext in the database (and therefore in every backup). The migration
// seals them with the credential key. All test tokens below are fake values
// that never belonged to a real provider.
const ACCESS = "fake-access-token-do-not-use-0123456789"
const REFRESH = "fake-refresh-token-do-not-use-9876543210"
const MIGRATION_ID = "20261106120000_seal_legacy_account_tokens"

const boot = (file: string, data: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.void
    }).pipe(
      Effect.provide(Database.layer({ path: file })),
      Effect.provideService(Global.Service, Global.make({ data })),
      Effect.scoped,
    ),
  )

const readTokens = (file: string) => {
  const raw = new BunDatabase(file, { readonly: true })
  try {
    return {
      account: raw.query("SELECT access_token, refresh_token FROM account").all() as Array<{
        access_token: string
        refresh_token: string
      }>,
      control: raw.query("SELECT access_token, refresh_token FROM control_account").all() as Array<{
        access_token: string
        refresh_token: string
      }>,
    }
  } finally {
    raw.close()
  }
}

describe("legacy account token sealing (A3-04)", () => {
  test("a legacy database boots with its account tokens sealed under the credential key", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")

    // Fresh boot: schema exists, account tables empty, migration marked done.
    await boot(file, tmp.path)

    // Rewind to the legacy state: the migration is pending again, and both
    // tables hold plaintext tokens the way an upstream opencode copy would.
    const raw = new BunDatabase(file)
    try {
      raw.run("DELETE FROM migration WHERE id = ?", [MIGRATION_ID])
      raw.run(
        "INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc-1', 'a@example.test', 'https://example.test', ?, ?, 0, 0)",
        [ACCESS, REFRESH],
      )
      raw.run(
        "INSERT INTO control_account (email, url, access_token, refresh_token, active, time_created, time_updated) VALUES ('c@example.test', 'https://example.test', ?, ?, 0, 0, 0)",
        [ACCESS, REFRESH],
      )
    } finally {
      raw.close()
    }

    // Second boot applies the pending migration.
    await boot(file, tmp.path)

    const key = readFileSync(path.join(tmp.path, "credential.key"))
    expect(key.length).toBe(CredentialEncryption.KEY_BYTES)
    const tokens = readTokens(file)
    expect(tokens.account).toHaveLength(1)
    expect(tokens.control).toHaveLength(1)
    for (const row of [...tokens.account, ...tokens.control]) {
      for (const value of [row.access_token, row.refresh_token]) {
        expect(value).not.toContain(ACCESS)
        expect(value).not.toContain(REFRESH)
        const envelope = JSON.parse(value)
        expect(envelope.enc).toBe(CredentialEncryption.ENVELOPE_VERSION)
      }
      expect(CredentialEncryption.decrypt(key, JSON.parse(row.access_token))).toBe(ACCESS)
      expect(CredentialEncryption.decrypt(key, JSON.parse(row.refresh_token))).toBe(REFRESH)
    }
  })

  test("sealing is idempotent: a second run leaves single envelopes that still open", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    await boot(file, tmp.path)

    const raw = new BunDatabase(file)
    try {
      raw.run("DELETE FROM migration WHERE id = ?", [MIGRATION_ID])
      raw.run(
        "INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc-1', 'a@example.test', 'https://example.test', ?, ?, 0, 0)",
        [ACCESS, REFRESH],
      )
    } finally {
      raw.close()
    }
    await boot(file, tmp.path)
    const once = readTokens(file).account[0]!

    // Rewind the journal again so the migration runs a second time.
    const raw2 = new BunDatabase(file)
    try {
      raw2.run("DELETE FROM migration WHERE id = ?", [MIGRATION_ID])
    } finally {
      raw2.close()
    }
    await boot(file, tmp.path)
    const twice = readTokens(file).account[0]!

    expect(twice.access_token).toBe(once.access_token)
    expect(twice.refresh_token).toBe(once.refresh_token)
    const key = readFileSync(path.join(tmp.path, "credential.key"))
    expect(CredentialEncryption.decrypt(key, JSON.parse(twice.access_token))).toBe(ACCESS)
  })
})

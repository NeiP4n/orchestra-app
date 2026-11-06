import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Global } from "@orchestra/util/global"
import { CredentialEncryption } from "../../credential/encryption.js"
import type { DatabaseMigration } from "../migration.js"

// A3-04: G2-10 sealed `credential.value` but left the legacy `account` /
// `control_account` OAuth tokens in plaintext. No code in Orchestra reads
// those tables any more — the live OAuth flow stores its tokens sealed in
// `credential` (the 20260805 legacy import moved them there) — but a
// database copied from an upstream opencode install can still carry live
// tokens in them, and every VACUUM INTO backup copied them verbatim. This
// migration seals whatever plaintext tokens are left, under the same key
// file, so no backup ever carries them in the clear again. A sealed value
// is an `orchestra-credential-v1` envelope holding the original token
// string; any future reader opens it with
// `CredentialEncryption.decrypt(key, envelope)`. Already-sealed values and
// empty values are left alone, so the migration is idempotent.
//
// The key file must never fail the boot: when it cannot be loaded or
// created (read-only data directory, corrupt file), the tokens stay
// plaintext as before, loudly, and the next boot retries.
const migration: DatabaseMigration.Migration = {
  id: "20261106120000_seal_legacy_account_tokens",
  up(tx) {
    return Effect.gen(function* () {
      const global = yield* Global.Service
      const keyFile = CredentialEncryption.resolveKeyFile(global.data)
      let key: Buffer
      try {
        key = CredentialEncryption.loadOrCreateKey(keyFile)
      } catch (cause) {
        yield* Effect.logWarning("legacy account tokens left unsealed: credential key file unusable", {
          keyFile,
          detail: cause instanceof Error ? cause.message : String(cause),
        })
        return
      }
      let sealed = 0
      sealed += yield* sealTable(tx, key, "account")
      sealed += yield* sealTable(tx, key, "control_account")
      if (sealed > 0)
        yield* Effect.logInfo("sealed legacy account tokens", { sealed, keyFile })
    })
  },
}

export default migration

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

const sealTable = (tx: Transaction, key: Buffer, table: "account" | "control_account") =>
  Effect.gen(function* () {
    const rows = yield* tx.all<{
      id?: string
      email?: string
      url?: string
      access_token: string
      refresh_token: string
    }>(
      table === "account"
        ? sql`SELECT id, access_token, refresh_token FROM account`
        : sql`SELECT email, url, access_token, refresh_token FROM control_account`,
    )
    let sealed = 0
    for (const row of rows) {
      const access = sealIfPlain(key, row.access_token)
      const refresh = sealIfPlain(key, row.refresh_token)
      if (access === row.access_token && refresh === row.refresh_token) continue
      if (table === "account") {
        yield* tx.run(sql`UPDATE account SET access_token = ${access}, refresh_token = ${refresh} WHERE id = ${row.id}`)
      } else {
        yield* tx.run(
          sql`UPDATE control_account SET access_token = ${access}, refresh_token = ${refresh} WHERE email = ${row.email} AND url = ${row.url}`,
        )
      }
      sealed += (access === row.access_token ? 0 : 1) + (refresh === row.refresh_token ? 0 : 1)
    }
    return sealed
  })

// Seal one stored token, or return it unchanged when there is nothing to
// seal: an empty value, or a value that is already an envelope.
function sealIfPlain(key: Buffer, value: string): string {
  if (value === "") return value
  if (isEnvelope(value)) return value
  return JSON.stringify(CredentialEncryption.encrypt(key, value))
}

function isEnvelope(value: string): boolean {
  try {
    return CredentialEncryption.isEnvelope(JSON.parse(value))
  } catch {
    return false
  }
}

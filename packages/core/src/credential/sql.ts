import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import type { Credential } from "../credential.js"

export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  // G2-10: the value is stored sealed (`CredentialEncryption.Envelope`) once
  // the credential store has encrypted it; legacy plaintext values still
  // decode until the startup migration seals them. The column stays TEXT —
  // no DDL change — the envelope is a JSON object like the value was.
  value: text({ mode: "json" }).$type<Credential.StoredValue>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})

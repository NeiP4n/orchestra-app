import { Database } from "@orchestra/core/database/database"
import { ModelsDev } from "@orchestra/core/models-dev"
import { PersistentPty } from "@orchestra/core/persistent-pty"
import { Schema } from "effect"

export const ServerOptions = Schema.Struct({
  app: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
    }),
  ),
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  // Session token lifetime in seconds; defaults to SESSION_TTL_SECONDS (7 days) when omitted.
  sessionTtlSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(30 * 24 * 60 * 60)),
  ),
  cors: Schema.optional(Schema.Array(Schema.String)),
  simulation: Schema.optional(Schema.Boolean),
  database: Schema.optional(Database.Options),
  pty: Schema.optional(PersistentPty.Options),
  events: Schema.optional(
    Schema.Struct({
      // G2-7: durable events persist by default (Bus treats an omitted value
      // as true). Set false only to deliberately drop event history on
      // restart — never for a live server.
      persist: Schema.optional(Schema.Boolean),
    }),
  ),
  backup: Schema.optional(
    Schema.Struct({
      // G2-8: automatic database backups. Enabled by default: one at server
      // startup (before the first live Society run) and then every
      // `intervalHours`, keeping the `keep` newest snapshots.
      enabled: Schema.optional(Schema.Boolean),
      intervalHours: Schema.optional(Schema.Number),
      keep: Schema.optional(Schema.Int),
      directory: Schema.optional(Schema.String),
    }),
  ),
  models: Schema.optional(ModelsDev.Options),
  config: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      project: Schema.optional(Schema.Boolean),
      file: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    }),
  ),
  windows: Schema.optional(
    Schema.Struct({
      gitbash: Schema.optional(Schema.String),
    }),
  ),
  fs: Schema.optional(
    Schema.Struct({
      filewatcher: Schema.optional(Schema.Boolean),
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type ServerOptions = typeof ServerOptions.Type

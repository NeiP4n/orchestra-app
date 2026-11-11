export * as Credential from "./credential.js"

import { asc, desc, eq } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Credential } from "@orchestra/schema/credential"
import { Integration } from "@orchestra/schema/integration"
import { Global } from "@orchestra/util/global"
import { Database } from "./database/database.js"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { CredentialTable } from "./credential/sql.js"
import { CredentialEncryption } from "./credential/encryption.js"
import { ErrorSummary } from "./util/error-summary.js"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const External = Credential.External
export type External = Credential.External

export const Value = Credential.Value
export type Value = Credential.Value

/** What the `credential.value` column holds: a sealed envelope, or a legacy plaintext value awaiting migration. */
export type StoredValue = CredentialEncryption.StoredValue

export const Event = Credential.Event

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

/** Public error text contains no provider response, account label or secret. */
export class RemovalError extends Schema.TaggedError<RemovalError>()("Credential.RemovalError", {
  reason: Schema.Literals(["owner_unavailable", "owner_failed"]),
  message: Schema.String,
}) {}

/** Keep plugin refusal diagnostics useful without logging arbitrary plugin strings. */
export function removalFailureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : undefined
  if (message === "Ambiguous account identity; reopen the account manager") return "Ambiguous account identity"
  if (message === "Conflicting account identity bindings; reopen the account manager") return "Conflicting account identity bindings"
  if (message === "Invalid account store format") return "Invalid account store format"
  if (message === "Unsupported account store version") return "Unsupported account store version"
  if (message === "Cannot read the account store") return "Cannot read the account store"
  return "Account manager removal failed"
}

export type RemovalOwner = (credential: Info) => ReadonlyArray<{
  readonly methodID: string
  readonly remove: Effect.Effect<void, unknown>
}>
const removalOwners = new WeakMap<Interface, Set<RemovalOwner>>()
/** Internal, scope-owned bridge. No credential details are broadcast as events. */
export function registerRemovalOwner(service: Interface, owner: RemovalOwner): () => void {
  let owners = removalOwners.get(service)
  if (!owners) removalOwners.set(service, owners = new Set())
  owners.add(owner)
  return () => { owners.delete(owner) }
}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /**
   * Creates a credential for an integration and returns the new record. The new credential becomes the
   * integration's selection unless `activate` is false and the integration already has a credential.
   */
  readonly create: (input: {
    readonly id?: ID
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
    readonly activate?: boolean
  }) => Effect.Effect<Info>
  /** Selects a stored credential for its integration. */
  readonly activate: (id: ID) => Effect.Effect<void>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void, RemovalError>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Credential") {}

type Codec =
  | { readonly mode: "encrypted"; readonly key: Buffer; readonly keyFile: string }
  | { readonly mode: "plaintext"; readonly reason: string }

const hasEncryptedRows = (db: Database.Interface["db"]) =>
  db
    .select({ value: CredentialTable.value })
    .from(CredentialTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.some((row) => CredentialEncryption.isEnvelope(row.value))),
    )

// How credentials are sealed. Encrypted whenever the key file is usable;
// plaintext only when the key cannot be persisted at all (a filesystem
// without a durable data directory, e.g. the workerd profile), with a loud
// warning — never silently.
const resolveCodec = (
  db: Database.Interface["db"],
  dataDir: string,
): Effect.Effect<Codec, CredentialEncryption.DecryptionError> =>
  Effect.gen(function* () {
    const keyFile = CredentialEncryption.resolveKeyFile(dataDir)
    const key = yield* CredentialEncryption.loadOrCreateKeyEffect(keyFile).pipe(
      Effect.catchTag("CredentialEncryption.KeyFileError", (error) =>
        Effect.gen(function* () {
          if (error.reason === "unavailable") {
            yield* Effect.logWarning("credential store encryption unavailable, credentials stay in plaintext", {
              keyFile,
              detail: error.detail,
            })
            return undefined
          }
          // A corrupt key file is only safe to replace when nothing is sealed with the lost key.
          const encrypted = yield* hasEncryptedRows(db)
          if (encrypted)
            return yield* Effect.fail(
              new CredentialEncryption.DecryptionError({
                reason:
                  `credential key file ${keyFile} is corrupt (${error.detail}) and the database holds encrypted credentials: ` +
                  "restore the key file from backup, or delete the encrypted credential rows and re-enter the keys",
              }),
            )
          yield* Effect.logWarning("credential key file corrupt with no encrypted credentials, generating a fresh key", {
            keyFile,
            detail: error.detail,
          })
          return yield* CredentialEncryption.regenerateKeyEffect(keyFile).pipe(
            Effect.mapError(
              (regenerateError) =>
                new CredentialEncryption.DecryptionError({
                  reason: `cannot regenerate credential key file ${keyFile}: ${regenerateError.detail}`,
                }),
            ),
          )
        })),
    )
    return key === undefined
      ? { mode: "plaintext", reason: "key file unavailable" }
      : { mode: "encrypted", key, keyFile }
  })

// Seal every legacy plaintext row and trial-open every sealed row, in one
// transaction: a row the current key cannot open fails startup honestly
// instead of surfacing as garbage later. No re-entry: plaintext rows are
// sealed with their own values, nothing is dropped.
const migrateStoredValues = (
  db: Database.Interface["db"],
  codec: Codec,
): Effect.Effect<{ readonly migrated: number; readonly verified: number }> =>
  Effect.gen(function* () {
    if (codec.mode === "plaintext") return { migrated: 0, verified: 0 }
    const decode = Schema.decodeUnknownSync(Value)
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx.select().from(CredentialTable).all().pipe(Effect.orDie)
          let migrated = 0
          let verified = 0
          for (const row of rows) {
            if (CredentialEncryption.isEnvelope(row.value)) {
              CredentialEncryption.decodeStored(codec.key, row.value, row.id)
              verified += 1
              continue
            }
            const sealed = CredentialEncryption.encodeStored(codec.key, decode(row.value))
            yield* tx
              .update(CredentialTable)
              .set({ value: sealed })
              .where(eq(CredentialTable.id, row.id))
              .run()
              .pipe(Effect.orDie)
            migrated += 1
          }
          return { migrated, verified }
        }),
      )
      .pipe(Effect.orDie)
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const decode = Schema.decodeUnknownSync(Value)
    // The credential layer stays infallible: a corrupt key is a startup
    // defect (the message carries the recovery steps), and consumers rely on
    // the node's error being never. Every other fallible call in this layer
    // is orDie'd the same way.
    const codec = yield* resolveCodec(db, global.data).pipe(Effect.orDie)
    const migration = yield* migrateStoredValues(db, codec)
    if (codec.mode === "encrypted")
      yield* Effect.logInfo("credential store encrypted at rest", {
        keyFile: codec.keyFile,
        migrated: migration.migrated,
        verified: migration.verified,
      })
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value:
          codec.mode === "encrypted"
            ? CredentialEncryption.decodeStored(codec.key, row.value, row.id)
            : decode(row.value),
      })
    }
    const storedRows = (rows: ReadonlyArray<typeof CredentialTable.$inferSelect>) =>
      rows.flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
    // Seal a value for storage; plaintext only in degraded mode (no key file).
    const seal = (value: Value) =>
      codec.mode === "encrypted" ? CredentialEncryption.encodeStored(codec.key, value) : value

    const removalLock = Semaphore.makeUnsafe(1)
    const service: Interface = Service.of({
      all: Effect.fn("Credential.all")(() =>
        db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(Effect.orDie, Effect.map(storedRows)),
      ),
      list: Effect.fn("Credential.list")((integrationID) =>
        db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(Effect.orDie, Effect.map(storedRows)),
      ),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: input.id ?? ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        const activated = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({ id: CredentialTable.id, active: CredentialTable.active })
                .from(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              const activate = input.activate !== false || !current
              if (activate)
                yield* tx
                  .update(CredentialTable)
                  .set({ active: false })
                  .where(eq(CredentialTable.integration_id, credential.integrationID))
                  .run()
              // Legacy rows have no active flag and the newest one is selected, so pin it before inserting a newer row.
              if (!activate && current && !current.active)
                yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, current.id)).run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: seal(credential.value),
                  active: activate,
                })
                .run()
              return activate
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential create failed", {
                credentialID: credential.id,
                integrationID: credential.integrationID,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        yield* Effect.logInfo("credential created", {
          credentialID: credential.id,
          integrationID: credential.integrationID,
          type: credential.value.type,
          active: activated,
        })
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (activated)
          yield* bus.publish(
            Event.Switched,
            { integrationID: credential.integrationID, credentialID: credential.id },
            { global: true },
          )
        return credential
      }),
      activate: Effect.fn("Credential.activate")(function* (id) {
        const integrationID = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
              if (!credential?.integration_id) return
              const active = yield* tx
                .select({ id: CredentialTable.id })
                .from(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integration_id))
                .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              if (active?.id === id) return
              yield* tx
                .update(CredentialTable)
                .set({ active: false })
                .where(eq(CredentialTable.integration_id, credential.integration_id))
                .run()
              yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, id)).run()
              return credential.integration_id
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential activate failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (integrationID) {
          yield* Effect.logInfo("credential activated", { integrationID, credentialID: id })
          yield* bus.publish(Event.Switched, { integrationID, credentialID: id }, { global: true })
        }
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (updates.label === undefined && updates.value === undefined) return
        const credential = yield* db
          .select({ integrationID: CredentialTable.integration_id, label: CredentialTable.label })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential update lookup failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!credential?.integrationID) {
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_missing" })
          return
        }
        if (updates.label === credential.label && updates.value === undefined) return
        const updated = yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value === undefined ? undefined : seal(updates.value) })
          .where(eq(CredentialTable.id, id))
          .returning({ id: CredentialTable.id })
          .get()
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential update failed", {
                credentialID: id,
                integrationID: credential.integrationID,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!updated) {
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_removed" })
          return
        }
        yield* Effect.logInfo("credential updated", {
          credentialID: id,
          integrationID: credential.integrationID,
          valueChanged: updates.value !== undefined,
          labelChanged: updates.label !== undefined && updates.label !== credential.label,
        })
        if (updates.label !== undefined && updates.label !== credential.label)
          yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return
        const credential = stored(row)
        if (credential?.value.type === "oauth") {
          const owners = Array.from(removalOwners.get(service) ?? []).flatMap(owner => owner(credential))
          const marker = credential.value.metadata?.removalOwner
          // Compatibility: native Antigravity records predate the generic owner marker.
          // Generic legacy Google OAuth cannot be classified safely without its pool owner.
          const required = typeof marker === "string" ? marker
            : credential.integrationID === "google" && (credential.value.methodID === "antigravity" || credential.value.methodID === "oauth" || typeof credential.value.metadata?.antigravityAccountId === "string") ? "antigravity" : undefined
          if (required && !owners.some(owner => owner.methodID === required))
            return yield* new RemovalError({ reason: "owner_unavailable", message: "The linked account manager is unavailable. Enable its plugin and retry. The credential was kept." })
          for (const owner of owners) {
            yield* owner.remove.pipe(Effect.catchCause(cause => Effect.gen(function* () {
              yield* Effect.logWarning("credential linked removal refused", {
                credentialID: id, integrationID: credential.integrationID,
                reason: removalFailureReason(Cause.squash(cause)),
              })
              return yield* new RemovalError({ reason: "owner_failed", message: "The linked account could not be removed. Check access to its account store and retry. The credential was kept." })
            })))
          }
        }
        const removed = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
              if (!credential) return
              const active = credential.integration_id
                ? yield* tx
                    .select({ id: CredentialTable.id })
                    .from(CredentialTable)
                    .where(eq(CredentialTable.integration_id, credential.integration_id))
                    .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
                    .get()
                : undefined
              yield* tx.delete(CredentialTable).where(eq(CredentialTable.id, id)).run()
              if (!credential.integration_id || active?.id !== id)
                return { switched: false as const, integrationID: credential.integration_id }
              const replacement = yield* tx
                .select({ id: CredentialTable.id })
                .from(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integration_id))
                .orderBy(desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              if (replacement) {
                yield* tx
                  .update(CredentialTable)
                  .set({ active: false })
                  .where(eq(CredentialTable.integration_id, credential.integration_id))
                  .run()
                yield* tx
                  .update(CredentialTable)
                  .set({ active: true })
                  .where(eq(CredentialTable.id, replacement.id))
                  .run()
              }
              return {
                switched: true as const,
                integrationID: credential.integration_id,
                credentialID: replacement?.id ?? null,
              }
            }),
          )
          .pipe(
            Effect.onError((cause) =>
              Effect.logError("credential remove failed", {
                credentialID: id,
                errors: ErrorSummary.from(Cause.squash(cause)),
              }),
            ),
            Effect.orDie,
          )
        if (!removed) return
        yield* Effect.logInfo("credential removed", {
          credentialID: id,
          integrationID: removed.integrationID,
          active: removed.switched,
          ...(removed.switched ? { replacementID: removed.credentialID } : {}),
        })
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (removed.switched)
          yield* bus.publish(
            Event.Switched,
            { integrationID: removed.integrationID, credentialID: removed.credentialID },
            { global: true },
          )
      }, removalLock.withPermit),
    })
    return service
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, Global.node] })

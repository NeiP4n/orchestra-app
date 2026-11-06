export * as CredentialEncryption from "./encryption.js"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { Credential } from "@orchestra/schema/credential"

// At-rest encryption for the credential store (gate G2-10).
//
// The `credential.value` column used to hold API keys and OAuth tokens as
// plaintext JSON, so anyone who could read the database file (or a backup of
// it) read every secret. Values are now sealed with AES-256-GCM under a
// random data-encryption key kept in a separate 0600 file next to the
// database. The database — and therefore every `VACUUM INTO` backup of it —
// holds ciphertext only.
//
// Why a key file, not the server password: the server password is fresh
// random bytes on every launch in the default paths (a standalone TUI server
// generates one per launch, `packages/cli/src/services/standalone.ts`; a
// foreground `serve` without `ORCHESTRA_PASSWORD` does the same,
// `packages/cli/src/server-process.ts`). Only service mode persists it
// (`packages/cli/src/services/service-config.ts`). Deriving the key from the
// password would make every stored credential undecryptable after a restart
// unless the operator sets a stable password — and core cannot tell a stable
// password from an ephemeral one, since both arrive through the same
// environment variable. A key file keeps the migration lossless and
// re-entry-free. The honest residual risk: a process running as the same OS
// user can read the key file, just as it could read the database before.
// Gating access per-process needs an OS keychain or a user passphrase; that
// is phase 2, drafted for block B27.

export const ENVELOPE_VERSION = "orchestra-credential-v1"
export const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_FILE_NAME = "credential.key"

/** A sealed credential value, stored as JSON in the `credential.value` column. */
export const Envelope = Schema.Struct({
  enc: Schema.Literal(ENVELOPE_VERSION),
  iv: Schema.String,
  data: Schema.String,
})
export type Envelope = typeof Envelope.Type

/** A stored `credential.value`: an envelope, or a legacy plaintext value awaiting migration. */
export type StoredValue = Envelope | Credential.Value

export class DecryptionError extends Schema.TaggedError<DecryptionError>()("CredentialEncryption.DecryptionError", {
  credentialID: Schema.optional(Schema.String),
  reason: Schema.String,
}) {}

export class KeyFileError extends Schema.TaggedError<KeyFileError>()("CredentialEncryption.KeyFileError", {
  path: Schema.String,
  // "unavailable" (cannot read/create the file) or "corrupt" (wrong length).
  // A plain string: Schema.Literal with two values rejects construction in this Effect version.
  reason: Schema.String,
  detail: Schema.String,
}) {}

export const isEnvelope = (value: unknown): value is Envelope =>
  Option.isSome(Schema.decodeUnknownOption(Envelope)(value))

export function createKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Seal `plaintext` under `key`. The IV is fresh per value; the GCM tag rides at the end of `data`. */
export function encrypt(key: Buffer, plaintext: string): Envelope {
  if (key.length !== KEY_BYTES) throw new Error(`credential encryption key must hold ${KEY_BYTES} bytes`)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const data = Buffer.concat([ciphertext, cipher.getAuthTag()])
  return { enc: ENVELOPE_VERSION, iv: iv.toString("base64url"), data: data.toString("base64url") }
}

/**
 * Open an envelope. A wrong key, a flipped bit, or a truncated payload fails
 * authentication and throws `DecryptionError` — it never returns garbage.
 */
export function decrypt(key: Buffer, envelope: Envelope, credentialID?: string): string {
  if (key.length !== KEY_BYTES) throw new Error(`credential encryption key must hold ${KEY_BYTES} bytes`)
  try {
    const combined = Buffer.from(envelope.data, "base64url")
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"))
    decipher.setAuthTag(combined.subarray(combined.length - TAG_BYTES))
    return Buffer.concat([
      decipher.update(combined.subarray(0, combined.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    throw new DecryptionError({
      ...(credentialID === undefined ? {} : { credentialID }),
      reason: "ciphertext failed authentication — wrong key or corrupt data",
    })
  }
}

/** Seal a credential value for storage. */
export const encodeStored = (key: Buffer, value: Credential.Value): Envelope =>
  encrypt(key, JSON.stringify(value))

/**
 * Open a stored value: envelopes decrypt, legacy plaintext values decode
 * as-is so a row written before encryption (or by another process mid-flight)
 * still reads instead of being lost.
 */
export function decodeStored(key: Buffer, stored: unknown, credentialID?: string): Credential.Value {
  if (!isEnvelope(stored)) return Schema.decodeUnknownSync(Credential.Value)(stored)
  const plaintext = decrypt(key, stored, credentialID)
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Credential.Value))(plaintext)
  if (Option.isNone(decoded))
    throw new DecryptionError({
      ...(credentialID === undefined ? {} : { credentialID }),
      reason: "decrypted credential payload is not a valid credential value",
    })
  return decoded.value
}

/** Re-seal an envelope under a new key (key rotation). The old key stops opening the result. */
export const reencryptEnvelope = (oldKey: Buffer, newKey: Buffer, envelope: Envelope): Envelope =>
  encrypt(newKey, decrypt(oldKey, envelope))

/** Key-file location: an explicit override wins, otherwise the data directory. */
export const resolveKeyFile = (dataDir: string): string =>
  process.env.ORCHESTRA_CREDENTIAL_KEY_FILE ?? join(dataDir, KEY_FILE_NAME)

// Filesystem calls throw by nature, so the key-file helpers below are plain
// synchronous functions that throw `KeyFileError`; the caller lifts them into
// Effect where the failure mode (degrade vs. fail) is decided.
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const readExistingKey = (path: string): Buffer | undefined => {
  try {
    return readFileSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new KeyFileError({ path, reason: "unavailable", detail: `cannot read credential key file: ${errorMessage(cause)}` })
  }
}

const writeKeyExclusive = (path: string, key: Buffer): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, "wx", 0o600)
    try {
      writeFileSync(fd, key)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (cause) {
    // Lost the creation race to another process: the winner's key is the one to use.
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false
    throw new KeyFileError({ path, reason: "unavailable", detail: `cannot create credential key file: ${errorMessage(cause)}` })
  }
}

// The key file is the crown jewel: tighten it on every load, the way the
// database file is tightened (`database.ts: restrictToOwner`). Windows relies
// on the user profile directory's inherited ACLs instead of POSIX modes.
const tightenKeyFile = (path: string): void => {
  if (process.platform === "win32") return
  try {
    chmodSync(path, 0o600)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw new KeyFileError({ path, reason: "unavailable", detail: `cannot restrict credential key file: ${errorMessage(cause)}` })
  }
}

/**
 * Load the data-encryption key, creating it (0600) on first use. Throws
 * `KeyFileError` with `reason: "corrupt"` when an existing file is not a
 * 32-byte key, and `"unavailable"` when the file cannot be read or created.
 */
export function loadOrCreateKey(path: string): Buffer {
  const existing = readExistingKey(path)
  if (existing !== undefined) {
    if (existing.length !== KEY_BYTES)
      throw new KeyFileError({
        path,
        reason: "corrupt",
        detail: `credential key file must hold ${KEY_BYTES} bytes, found ${existing.length}`,
      })
    tightenKeyFile(path)
    return existing
  }
  const key = createKey()
  if (writeKeyExclusive(path, key)) {
    tightenKeyFile(path)
    return key
  }
  const winner = readExistingKey(path)
  if (winner === undefined || winner.length !== KEY_BYTES)
    throw new KeyFileError({ path, reason: "unavailable", detail: "credential key file disappeared during creation" })
  tightenKeyFile(path)
  return winner
}

/** Drop a (corrupt) key file and create a fresh one. Only safe when no encrypted rows depend on the old key. */
export function regenerateKey(path: string): Buffer {
  if (existsSync(path)) rmSync(path)
  return loadOrCreateKey(path)
}

/** Lift a key-file failure into Effect, preserving the typed error. */
export const loadOrCreateKeyEffect = (path: string): Effect.Effect<Buffer, KeyFileError> =>
  Effect.try({
    try: () => loadOrCreateKey(path),
    catch: (cause) =>
      cause instanceof KeyFileError
        ? cause
        : new KeyFileError({ path, reason: "unavailable", detail: errorMessage(cause) }),
  })

/** Drop a (corrupt) key file and create a fresh one, as an Effect. Only safe when no encrypted rows depend on the old key. */
export const regenerateKeyEffect = (path: string): Effect.Effect<Buffer, KeyFileError> =>
  Effect.try({
    try: () => regenerateKey(path),
    catch: (cause) =>
      cause instanceof KeyFileError
        ? cause
        : new KeyFileError({ path, reason: "unavailable", detail: errorMessage(cause) }),
  })

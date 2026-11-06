# core/credential — storage of integration credentials in SQLite

## What's In This Folder

- `sql.ts` — the only file: the drizzle-orm sqlite schema of the `credential` table.
- `encryption.ts` — at-rest encryption for the stored values (AES-256-GCM, key file). See below.
- There is no other runtime logic in the folder: reading and writing live in the root `packages/core/src/credential.ts`.

## Key Files

- `packages/core/src/credential/sql.ts` — `CredentialTable`.
- `packages/core/src/credential/encryption.ts` — `CredentialEncryption` (envelope, key file, errors).
- `packages/core/src/credential.ts` — the service that reads and writes this table.

## Important Details

- The table columns: `id` (primary key, of type `Credential.ID` from `packages/core/src/credential.ts`), `integration_id`, `label`, `value`, `connector_id`, `method_id`, `active`, plus the shared `Timestamps` set from `packages/core/src/database/schema.sql.ts`.
- `value` is a `text({ mode: "json" })` column with the type `Credential.StoredValue`: either a sealed envelope (`CredentialEncryption.Envelope`) or a legacy plaintext `Credential.Value` awaiting migration. The type comes by an `import type`, that is, at the table build stage it is only a column annotation.
- The column is still TEXT — encryption changed no DDL. An envelope is a JSON object like the value was.

## Encryption at rest (G2-10)

- Values are sealed with AES-256-GCM under a random 32-byte data key kept in `<data>/credential.key` (0600, tightened on every load; override with `ORCHESTRA_CREDENTIAL_KEY_FILE`). The database — and therefore every `VACUUM INTO` backup of it — holds ciphertext only. The key is NOT derived from the server password: the password is fresh random bytes on every launch in the default paths (standalone TUI server, foreground `serve` without `ORCHESTRA_PASSWORD`), so a password-derived key would make stored credentials undecryptable after a restart. Only service mode persists the password.
- On first use of the credential service, a startup migration (one transaction) seals every legacy plaintext row and trial-opens every sealed row. Nothing is dropped and no key has to be re-entered.
- A wrong or corrupt key file fails startup honestly with a `DecryptionError` naming the problem (restore the key file from backup, or delete the encrypted rows and re-enter the keys). A corrupt key file with no encrypted rows is replaced with a fresh key. If the key file cannot be created or persisted at all (a filesystem without a durable data directory, e.g. the workerd profile), the store degrades to plaintext with a loud warning at startup — never silently.
- Residual risk, stated plainly: a process running as the same OS user can read the key file, just as it could read the database before. This closes "plaintext in SQLite and in backups", not "same-user process isolation". Per-access gating (OS keychain, user passphrase) is phase 2, drafted for block B27.
- Old backups made before the migration still hold plaintext keys: delete them, or rotate the keys they contain. The same applies to any database copy taken before the migration.
- `label` is declared `.notNull()`, while `integration_id`, `connector_id`, `method_id` and `active` are optional. `active` is at the same time `integer({ mode: "boolean" })`, that is, it accepts the values 0/1 and can be `null`: in SQLite that is not the same as `false`.
- The schema only reads types and imports no services: the only dependency of the folder is `packages/core/src/database/schema.sql.ts` (the `Timestamps` set).
- The table is declared in terms of core entities (`Credential.ID`, `Credential.Value`), not in terms of the application domain. The table schema does not know what an integration is or what authorizes it.

## Connections

- `packages/core/src/credential.ts` — the only consumer of `CredentialTable` (verified by searching the table name over `packages/core/src`).
- `packages/core/src/config.ts` — subscribes to `Credential.Event.Switched` and re-reads the config when the account of an integration taking part in a wellknown config has changed.
- `packages/core/src/config.ts` — when loading a wellknown entry it takes the latest credential of the integration and requires `credential.value.type === "key"`: entries of other types do not substitute the config.
- `packages/core/docs/permission.md` — a neighboring mechanism in meaning: permissions saved by the user also live in SQLite, but per project.
- `packages/core/docs/account.md` — another table with tokens; it is unused (see the pitfalls).

## Pitfalls

- The table declares no foreign keys on `integration_id`, `connector_id`, `method_id`: the integrity of the relations is held by the code, not by the database.
- `active` admits `null`. Code reading it as a flag must itself decide what the absence of a value means.
- The type `Credential.Value` is imposed by a `$type` annotation, not by a check: a value written into the table against the schema will have nothing to decode it later.
- The table has exactly one consumer in common, so any edit of the columns breaks only `credential.ts` — but an edit in the other direction (reading a field that is not in the table) already breaks at the type level.
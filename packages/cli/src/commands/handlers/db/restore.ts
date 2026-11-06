import { EOL } from "node:os"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { DatabaseBackup } from "@orchestra/core/database/backup"
import { CredentialEncryption } from "@orchestra/core/credential/encryption"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { databasePath } from "../../../database-path"
import { assertServerStopped } from "../server-stopped"

// A3-03: the atomic restore existed only as a library function — an operator
// in a crash would have restored by hand (`cp` over the live database, the
// exact mistake G2-8 fixed). This is its entry point.
//
// The server must be stopped: an open connection would keep writing to the
// replaced inode. The check looks for a live foreground-server PID lock and
// for a registered background service, and refuses unless --force says the
// operator is sure the server is stopped (for example, a stale lock after a
// SIGKILL). The restore itself is the atomic pair restore in core:
// database + credential key, verified before and after, with rollback.
export default Runtime.handler(
  Commands.commands.db.commands.restore,
  Effect.fn("cli.db.restore")(function* (input) {
    const global = yield* Global.Service
    const dbFile = databasePath(global.data)
    if (dbFile === ":memory:") return yield* Effect.fail(new Error("No file database to restore: this install uses :memory:"))
    const backup = path.resolve(input.backup)
    if (!existsSync(backup)) return yield* Effect.fail(new Error(`No backup file at ${backup}`))
    yield* assertServerStopped(global.data, input.force, "restore")
    const keyFile = CredentialEncryption.resolveKeyFile(global.data)
    const restored = yield* DatabaseBackup.restoreDatabase(dbFile, backup, { keyFile })
    const keyLine =
      restored.key === "restored"
        ? "Credential key: restored from the backup next to it."
        : restored.key === "kept-live"
          ? "Credential key: kept from the live install (it opens the backup's credentials)."
          : "Credential key: not needed (the backup holds no encrypted credentials)."
    process.stdout.write(
      [
        `Restored ${restored.database} from ${backup}.`,
        keyLine,
        `Start the server again (\`orchestra serve\` or \`orchestra service start\`) and check it starts and your credentials still work.`,
        ``,
      ].join(EOL),
    )
  }),
)

// A live foreground server leaves `server.lock` / `server-<port>.lock` naming
// its pid. A lock naming a dead pid (or an unreadable lock) is stale, not live.
export function findLiveServerLock(dataDir: string): { file: string; pid: number } | undefined {
  let names: Array<string>
  try {
    names = readdirSync(dataDir).filter((name) => /^server(-\d+)?\.lock$/.test(name))
  } catch {
    return undefined
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dataDir, name), "utf8"))
      const pid =
        typeof parsed === "object" && parsed !== null && "pid" in parsed
          ? (parsed as { pid?: unknown }).pid
          : undefined
      if (typeof pid !== "number") continue
      try {
        process.kill(pid, 0)
        return { file: name, pid }
      } catch {
        // Dead pid: stale lock, not a live server.
      }
    } catch {
      // Unreadable lock: never block a restore over it.
    }
  }
  return undefined
}

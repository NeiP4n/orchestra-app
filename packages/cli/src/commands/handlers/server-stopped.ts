import { Effect } from "effect"
import { Service } from "@orchestra/client/effect/service"
import { ServiceConfig } from "../../services/service-config"
import { findLiveServerLock } from "./db/restore"

// A database file must not be rewritten while a server holds it open: an
// open connection keeps writing to the replaced inode. Refuses when a live
// foreground-server lock or a registered background service is found, unless
// --force says the operator is sure the server is stopped (for example, a
// stale lock after a SIGKILL).
export const assertServerStopped = (dataDir: string, force: boolean, action: string) =>
  Effect.gen(function* () {
    if (force) return
    const liveLock = findLiveServerLock(dataDir)
    if (liveLock !== undefined)
      return yield* Effect.fail(
        new Error(
          `A server looks live (pid ${liveLock.pid}, lock ${liveLock.file}): stop it first ` +
            `(\`orchestra service stop\`, or stop the foreground \`orchestra serve\`), then ${action} again. ` +
            `If the process is really gone, re-run with --force.`,
        ),
      )
    const service = yield* Service.discover({ ...(yield* ServiceConfig.options()), version: undefined }).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (service !== undefined)
      return yield* Effect.fail(
        new Error(
          `A background server is running at ${service.url}: stop it first (\`orchestra service stop\`), ` +
            `then ${action} again. If the service is really gone, re-run with --force.`,
        ),
      )
  })

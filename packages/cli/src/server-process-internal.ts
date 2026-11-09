/** @internal Implementation shared by the public entry and isolated test runner. Not a package export. */
import { NodeServices } from "@effect/platform-node"
import { Service } from "@orchestra/client/effect/service"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { ORCHESTRA_ARTIFACT, ORCHESTRA_CHANNEL, ORCHESTRA_VERSION } from "./version"
import { AppProcess } from "@orchestra/util/process"
import { OwnershipLost, isOnlyOwnershipLost } from "@orchestra/server/managed-stop"
import { onParentExit } from "@orchestra/util/parent-exit"
import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Redacted, Schema } from "effect"
import { PersistentPty } from "@orchestra/schema/persistent-pty"
import { HttpServer } from "effect/unstable/http"
import { Env } from "./env"
import { ServiceConfig } from "./services/service-config"
import { RetainedImage } from "./services/retained-image"
import { ServiceClaim } from "./services/service-claim"
import { ServerLifecycle } from "./services/server-lifecycle"
import { ServiceRegistration } from "./services/service-registration"
import { WebUi } from "./services/web-ui"
import { databasePath } from "./database-path"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

interface ManagedBootProbe {
  readonly beforeManagedBoot?: Effect.Effect<void>
  readonly afterManagedStart?: Effect.Effect<void>
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const runProcess = Effect.fnUntraced(function* (options: Options, probe?: ManagedBootProbe) {
  return yield* processEffect(options, probe).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
        replacements: [
          Global.node.replace(
            Global.layerWith(process.env.ORCHESTRA_CONFIG_DIR ? { config: process.env.ORCHESTRA_CONFIG_DIR } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
    // Settle only after all provided layers and scopes have finalized.
    Effect.catchCause((cause) =>
      isOnlyOwnershipLost(cause)
        ? Effect.logInfo("managed contender conceded ownership", { reason: "ownership-lost" })
        : Effect.failCause(cause),
    ),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options, probe?: ManagedBootProbe) {
  const inherited = process.env.ORCHESTRA_PTY_HANDOFF
  delete process.env.ORCHESTRA_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.catch(() =>
            Effect.logWarning("Ignoring invalid PTY restart handoff; persistent terminals will start fresh").pipe(
              Effect.as(undefined),
            ),
          ),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const findIncumbent =
        serviceOptions !== undefined && port !== undefined
          ? Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (findIncumbent !== undefined && (yield* findIncumbent) !== undefined) return
      if (serviceOptions !== undefined) {
        // Only the claim holder starts; sibling contenders yield to it instead of
        // overwriting its registration once it registers (see ServiceClaim).
        const verdict = yield* ServiceClaim.acquire({
          file: serviceOptions.file,
          incumbent:
            findIncumbent === undefined ? undefined : Effect.map(findIncumbent, (found) => found !== undefined),
        })
        if (verdict === "yield") return
        yield* Effect.addFinalizer(() => ServiceClaim.release(serviceOptions.file))
      }
      // B14: the foreground server died silently and the next start had no
      // idea the previous run ended uncleanly; the old process had also
      // ignored SIGTERM while the replacement fought it for the port. The
      // default (foreground) mode therefore owns a PID lock plus a shutdown
      // marker in the data directory: a second start refuses loudly naming
      // the live incumbent, and a start that finds no clean marker reports
      // the unclean death. Service mode already owns startup through
      // ServiceClaim + registration, and stdio mode is owned by its parent's
      // lease — neither writes this file, so the verdict stays unambiguous.
      const lifecycle =
        options.mode === "default"
          ? yield* Effect.gen(function* () {
              const previousRun = yield* ServerLifecycle.readPreviousRun(global.data)
              const lockInfo = {
                pid: process.pid,
                hostname,
                port: port ?? null,
                mode: options.mode,
                startedAt: new Date().toISOString(),
              } as const
              yield* ServerLifecycle.acquireLock(global.data, lockInfo)
              yield* Effect.addFinalizer(() => ServerLifecycle.releaseLock(global.data, port ?? null))
              yield* ServerLifecycle.markStarted(global.data, lockInfo, previousRun).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "Could not write the server lifecycle state; the next start cannot tell whether this run ended cleanly",
                    { cause },
                  ),
                ),
              )
              yield* ServerLifecycle.reportPreviousRun(previousRun)
              return lockInfo
            })
          : undefined
      // Keep a package-manager or curl install replaceable while the service runs; Desktop updates its own copy.
      if (options.mode === "service" && process.platform === "win32" && RetainedImage.installed(global.home))
        yield* RetainedImage.retain(global.cache, "service")
      const { start } = yield* Effect.promise(() => import("@orchestra/server/process"))
      // If the configured service port belongs to an unrelated process (for example a Desktop
      // instance using a different registration directory), let the OS choose a free port.
      // Clients discover the actual URL from the registration written by onListen below.
      let listenPort = port
      // Set synchronously by the signal handler in waitForTermination (the
      // generator never sees the resume value: runMain interrupts the main
      // fiber on SIGINT/SIGTERM). The shutdown-marker finalizer reads it.
      let shutdownReason: string | undefined
      // Set once the server is up and listening: the shutdown-marker
      // finalizer treats a scope closing after this point as a clean
      // shutdown (see the finalizer comment below).
      let reachedListening = false
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.ORCHESTRA_PASSWORD
        delete process.env.ORCHESTRA_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : // Arch3 №8: a foreground server used to print its generated
              // password to the console — the only copy, and visible to
              // anyone reading the log. The password is now stored in the
              // 0600 service config instead (reused across restarts, like
              // the managed service's), and the console only says where to
              // read it. A password from the environment is never written
              // to the file: the operator owns that copy.
              yield* ServiceConfig.password().pipe(
                Effect.mapError(
                  (error) =>
                    new Error("Could not store the generated server password in the service config", {
                      cause: error,
                    }),
                ),
              )
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      // The web shell is built artifacts, not source: a missing, incomplete
      // or stale dist serves a broken page. Say so loudly at startup, in
      // the serve log, instead of letting the browser show a blank page.
      yield* WebUi.checkStartupHealth()
      const launch = () =>
        start(
          {
            app: {
              name: process.env.ORCHESTRA_CLIENT ?? ORCHESTRA_ARTIFACT,
              version: ORCHESTRA_VERSION,
              channel: ORCHESTRA_CHANNEL,
            },
            hostname,
            port: listenPort,
            cors: options.cors ?? config.cors,
            password,
            pty: { handoff },
            simulation: truthy(process.env.ORCHESTRA_SIMULATE),
            database: {
              path: databasePath(global.data),
            },
            models: {
              url: process.env.ORCHESTRA_MODELS_URL,
              file: process.env.ORCHESTRA_MODELS_PATH,
              fetch: !truthy(process.env.ORCHESTRA_DISABLE_MODELS_FETCH),
            },
            config: {
              directory: process.env.ORCHESTRA_CONFIG_DIR,
              project: !truthy(
                process.env.ORCHESTRA_CONFIG_PROJECT_DISABLE ?? process.env.ORCHESTRA_DISABLE_PROJECT_CONFIG,
              ),
              file: process.env.ORCHESTRA_CONFIG,
              content: process.env.ORCHESTRA_CONFIG_CONTENT,
            },
            windows: {
              gitbash: process.env.ORCHESTRA_GIT_BASH_PATH,
            },
            fs: {
              filewatcher: !truthy(
                process.env.ORCHESTRA_FILEWATCHER_DISABLE ?? process.env.ORCHESTRA_DISABLE_FILEWATCHER,
              ),
              fff:
                process.env.ORCHESTRA_DISABLE_FFF === undefined
                  ? process.platform !== "win32"
                  : !truthy(process.env.ORCHESTRA_DISABLE_FFF),
            },
          },
          serviceOptions === undefined
            ? undefined
            : {
                beforeManagedBoot: probe?.beforeManagedBoot,
                onManagedListen: (address, requestStop) =>
                  Effect.gen(function* () {
                    if (!config.password) yield* ServiceConfig.password(password)
                    return yield* ServiceRegistration.register({
                      address,
                      password,
                      id: instanceID,
                      file: serviceOptions.file,
                      requestStop,
                    })
                  }),
              },
          transform,
        )
      const server = yield* launch().pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || !addressInUse(error)) return Effect.fail(error)
          // A configured port can be occupied by another OpenCode install or a stale process
          // whose registration lives elsewhere. Do not wait/retry the same port: bind to an
          // OS-selected free port immediately and publish that actual address in registration.
          return Effect.gen(function* () {
            yield* Effect.logWarning(
              `Managed service port ${port} on ${hostname} is occupied; retrying on an OS-assigned port`,
            )
            listenPort = 0
            return yield* launch().pipe(
              Effect.mapError((fallbackError) =>
                fallbackError instanceof OwnershipLost
                  ? fallbackError
                  : new Error(
                      `Managed service failed to start on configured port ${port} and on an OS-assigned port.`,
                      { cause: fallbackError },
                    ),
              ),
            )
          })
        }),
      )
      if (server === undefined) return
      if (options.mode === "service" && probe?.afterManagedStart) yield* probe.afterManagedStart
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (foreground && !environmentPassword)
        console.log("server password saved — run `orchestra service get password` to show it")
      // Which code this server runs: its git commit (when started from a checkout) and start time, written beside the
      // data so `orchestra service status` can show it. The version number alone does not change between commits.
      yield* Effect.promise(async () => {
      try {
        const { execFileSync } = await import("node:child_process")
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
        let sha = "unknown"
        try {
          sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: here, encoding: "utf8", timeout: 3000, windowsHide: true }).trim() || sha
        } catch {}
        mkdirSync(global.data, { recursive: true })
        writeFileSync(`${global.data}/server-build.json`, JSON.stringify({ sha, startedAt: new Date().toISOString(), pid: process.pid }))
      } catch {}
      }).pipe(Effect.ignore)
      // A normal stop closes the browser sessions' Chromes gracefully, so logins (cookies) reach the profile on disk.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const { BrowserRuntime } = await import("@orchestra/core/browser/runtime")
          await BrowserRuntime.closeAllGraceful(4000)
        }).pipe(Effect.ignore),
      )
      if (options.mode === "service") return yield* server.shutdown
      if (options.mode === "stdio") return yield* waitForStdinClose()
      reachedListening = true
      // The clean-shutdown marker is written by a finalizer, not by code
      // after waitForTermination: NodeRuntime.runMain interrupts the main
      // fiber on SIGINT/SIGTERM — and its signal handler was registered
      // before ours, so the interruption's finalizers run before our own
      // signal listener even fires (verified live: the finalizer logged
      // before "signal received"). The generator therefore never continues
      // past the wait, and the reason the listener records is usually not
      // set yet when the finalizer runs. So the finalizer keys on
      // `reachedListening` instead: a scope that closes after the server
      // was up and listening closed through the normal shutdown path, and
      // that is what "clean" means here. The recorded signal, when the
      // resume wins the race and it is set, refines the reason; otherwise
      // the marker says "graceful shutdown". A startup failure leaves the
      // flag unset, so the marker stays unclean, as it should. This
      // finalizer is the last one registered, so the first to run on scope
      // close (LIFO) — before any wedged server finalizer can block it;
      // the 10s forced exit is the backstop.
      yield* Effect.addFinalizer(() =>
        lifecycle === undefined || !reachedListening
          ? Effect.void
          : ServerLifecycle.markStopped(global.data, shutdownReason ?? "graceful shutdown").pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "Could not write the clean-shutdown marker; the next start will report this run as unclean",
                  { cause },
                ),
              ),
            ),
      )
      yield* waitForTermination((reason) => {
        shutdownReason = reason
      })
      return
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

// A foreground server lives as long as the terminal that started it. Closing that terminal sends
// SIGHUP (and SIGBREAK on Windows); without a listener the signal is delivered to the whole process
// group and the server can be left behind as an orphan that keeps its port and its sessions. Owning
// the signal here ends the scope, so the server's finalizers run and the process exits.
//
// Signals are not enough on Windows (see onParentExit), so the parent shell is watched as well.
// A forced exit follows the finalizers, because a wedged PTY or database must not keep the
// process alive after the terminal is gone.
const TERMINATION_GRACE_MS = 10_000

/**
 * Waits for the signal that ends a foreground server.
 *
 * `onSignal` runs synchronously inside the signal handler: NodeRuntime.runMain
 * interrupts the main fiber on SIGINT/SIGTERM, so the generator waiting here
 * never resumes normally — only scope finalizers run afterwards. Anything the
 * shutdown needs to know (here: the reason for the clean-shutdown marker)
 * must be recorded here, not in code after the wait.
 *
 * SIGINT is owned here too: before B14, Ctrl-C killed the process through
 * the default disposition, so no finalizer — and no shutdown marker — ever
 * ran for the most common foreground stop.
 */
function waitForTermination(onSignal: (reason: string) => void) {
  return Effect.callback<void>((resume) => {
    let finished = false
    const done = (reason: string) => {
      if (finished) return
      finished = true
      onSignal(reason)
      // Start the forced-exit clock NOW, not after the finalizers: a wedged
      // PTY or database finalizer must not make SIGTERM look ignored (B14:
      // the old server never exited after SIGTERM). A graceful shutdown
      // that finishes inside the grace period still wins.
      forceExitAfterGrace()
      resume(Effect.void)
    }
    const signals: NodeJS.Signals[] = ["SIGHUP", "SIGTERM", "SIGINT"]
    if (process.platform === "win32") signals.push("SIGBREAK")
    const listeners = signals.map((signal) => {
      const listener = () => done(`signal ${signal}`)
      process.once(signal, listener)
      return { signal, listener }
    })
    const stopWatchingParent = onParentExit(() => done("parent process exited"))
    return Effect.sync(() => {
      for (const { signal, listener } of listeners) process.off(signal, listener)
      stopWatchingParent()
      if (finished) forceExitAfterGrace()
    })
  })
}

function forceExitAfterGrace() {
  const timer = setTimeout(() => process.exit(0), TERMINATION_GRACE_MS)
  timer.unref?.()
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}

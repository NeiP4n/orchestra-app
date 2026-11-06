export * as ServerProcess from "./process"

import { NodeHttpServer } from "@effect/platform-node"
import { Bus } from "@orchestra/core/bus"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { SessionRestart } from "@orchestra/core/session/execution/restart"
import { Federation } from "@orchestra/core/federation"
import { Orchestra } from "@orchestra/core/orchestra"
import { Database } from "@orchestra/core/database/database"
import { InstallationEvent } from "@orchestra/schema/installation-event"
import { hasPtyConnectTicketURL } from "@orchestra/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@orchestra/protocol/groups/persistent-pty"
import { isPairingConnectURL } from "@orchestra/protocol/groups/server"
import { isRoomGuestURL } from "@orchestra/protocol/groups/room"
import { Global } from "@orchestra/util/global"
import { Cause, Context, Effect, Exit, Latch, Layer, Option, Ref, Scope } from "effect"
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { ServerAuth } from "./auth"
import { isAllowedCorsOrigin } from "./cors"
import { ServerDatabaseBackup } from "./database-backup"
import { authorizedRequest, unauthorizedResponse } from "./middleware/authorization"
import { withoutParentSpan } from "./request-tracing"
import { createRoutes } from "./routes"
import { ServerInfo } from "./server-info"
import { ServerRoomDiscovery } from "./room-discovery"
import { Status } from "./service-status"
import { aliasRequest } from "./alias"
import type { ServerOptions } from "./options"

export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    address: HttpServer.Address,
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

export type Transform = (app: App) => App

const errorResponseLogger = HttpMiddleware.make((app) =>
  HttpMiddleware.logger(
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  options: ServerOptions,
  lifecycle?: Lifecycle<E, R>,
  transform?: Transform,
) {
  const password = options.password
  if (!password) return yield* Effect.fail(new Error("Missing server password"))
  const hostname = options.hostname ?? "127.0.0.1"
  const port = Option.fromNullishOr(options.port)
  const shutdown = yield* Latch.make()
  const status = yield* Status.make()
  const bound = yield* listen({ hostname, port })
  const urls = () => {
    const address = bound.server.address()
    if (address === null || typeof address === "string") return []
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address
    return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
  }
  const application = yield* Ref.make(Option.none<App>())
  const app = dispatch(password, status, application, options.app?.version ?? "unknown", urls, Global.Path.tmp)
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  yield* bound.http
    .serve(
      (transform ? transform(app) : app).pipe(
        HttpMiddleware.compression(),
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      errorResponseLogger,
    )
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices), withoutParentSpan)
  // Only a server other devices can reach answers room discovery.
  const address = bound.server.address()
  if (!isLoopback(hostname) && address !== null && typeof address !== "string")
    yield* ServerRoomDiscovery.respond(address.port)
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      Effect.flatMap((cleanup) =>
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      Effect.uninterruptible,
    )

  const parentScope = yield* Scope.Scope
  const applicationScope = yield* Scope.fork(parentScope)
  yield* Effect.addFinalizer(() =>
    status.beginStopping.pipe(
      Effect.andThen(Ref.set(application, Option.none())),
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
    ),
  )

  const boot = Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          ...options,
          password,
        },
        urls,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      applicationScope,
    )
    // The cycle self-configures on first use: Config is location-scoped and
    // the built routes context holds no `Config.Service` (verified by probe),
    // so the Autoloop service applies the operator's `Config.Orchestra.Autoloop`
    // limits and the dispatch rules itself, the first time a dispatch runs in
    // a config-bearing context. Until then the kernel defaults apply, and the
    // clock below only ticks once runs exist.
    // G2-8: back the live database up before the first live run — the startup
    // hold below resumes founded Societies, so this snapshot is the one a
    // failed live run (Б14) restores from. Then keep backing up on schedule.
    // Never fails the boot: a server the operator cannot start cannot be fixed.
    const { db } = Context.get(context, Database.Service)
    const global = Context.get(context, Global.Service)
    yield* ServerDatabaseBackup.start(db, global, options.backup).pipe(
      Effect.provideService(Scope.Scope, applicationScope),
    )
    if (lifecycle) {
      yield* installRestartContinuity(
        Context.get(context, Autoloop.Service),
        Context.get(context, SessionRestart.Service),
        Context.get(context, Orchestra.Service),
        Context.get(context, Federation.Service),
      ).pipe(Effect.provideService(Scope.Scope, applicationScope))
    }
    // The autoloop clock rises with the server and falls with it: its loop
    // lives in the application scope, and its state is the journal, so a
    // restart resumes the runs instead of losing them.
    yield* Context.get(context, Autoloop.Service)
      .start()
      .pipe(Effect.provideService(Scope.Scope, applicationScope))
    yield* Ref.set(application, Option.some(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()))
    yield* status.ready
    const bus = Context.get(context, Bus.Service)
    return {
      address: bound.http.address,
      shutdown: shutdown.await,
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      return status.fail.pipe(
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        Effect.andThen(Effect.never),
      )
    }),
  )
  if (!lifecycle) return yield* boot
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

function listen(options: { readonly hostname: string; readonly port: Option.Option<number> }) {
  if (Option.isSome(options.port)) return bind(options.hostname, options.port.value)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(options.hostname, port).pipe(
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  return next(4096)
}

function bind(hostname: string, port: number) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    return yield* Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { port, host: hostname })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

function addressInUse(error: unknown) {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  const cause = error.cause
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

function dispatch(
  password: string,
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
): App {
  const auth = ServerAuth.Config.of({ password: Option.some(password), username: "opencode" })
  return Effect.gen(function* () {
    const rawRequest = yield* HttpServerRequest.HttpServerRequest
    const request = aliasRequest(rawRequest)
    const url = new URL(request.url, "http://localhost")
    const state = yield* status.current
    const app = yield* Ref.get(application)
    const ready = state.type === "ready" && Option.isSome(app)
    if (request.method === "GET" && url.pathname === "/api/info" && !ready) {
      if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
      return yield* infoResponse(status, version, urls, tmp)
    }
    // Pairing links and room guest routes carry their own proof (a code or a room
    // token) that the handlers check; everything else needs the server credential.
    // /health is unauthenticated by design (G2-6): monitoring polls it without
    // credentials, and when the server is not ready yet it answers 503 below
    // instead of 200 — never 401.
    if (
      !isPairingConnectURL(url) &&
      !(ready && isRoomGuestURL(url)) &&
      (!ready || (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url))) &&
      url.pathname !== "/health" &&
      !(yield* authorizedRequest(request, auth))
    )
      return unauthorizedResponse(request)
    if (ready) {
      return yield* request === rawRequest
        ? app.value
        : app.value.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    }
    return unavailable(state)
  })
}

const infoResponse = Effect.fnUntraced(function* (
  status: Status.Interface,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
) {
  const state = yield* status.current
  return HttpServerResponse.jsonUnsafe(
    { version, pid: process.pid, urls: urls(), paths: { tmp } },
    {
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

function unavailable(status: Status.State) {
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        code: "service_failed",
        message: "The background service could not start.",
        action: "Run `orchestra service restart` after checking the service logs.",
      },
      { status: 503 },
    )
  return HttpServerResponse.jsonUnsafe(
    { code: status.type === "stopping" ? "service_stopping" : "service_starting" },
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
const installRestartContinuity = Effect.fnUntraced(function* (
  autoloop: Autoloop.Interface,
  restart: SessionRestart.Interface,
  orchestra: Orchestra.Interface,
  federation: Federation.Interface,
) {
  // This server owns the durable restart sweep; after registering resumed turns, also
  // reconcile idle task markers whose terminal event notification may have been missed.
  const reportStartupFailure = (label: string, effect: Effect.Effect<void, unknown>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(label, { cause }),
      ),
    )
  // One startup pass through the journal: Societies are held as journaled
  // first, then the cycle decides what its runs do next (re-queued runs come
  // due, quiet workers are noticed), suspended sessions resume in a single
  // sweep, and Orchestra task markers reconcile. Each step is independent:
  // one failing must not suppress the rest.
  // G2-1: the provider preflight runs at boot, before the startup hold
  // resumes founded Societies — so a dead key is one loud log line at
  // startup instead of a stalled Society discovered from the logs later.
  // It never fails the boot: the operator needs the server up to fix the key.
  const reportPreflight = Effect.gen(function* () {
    const result = yield* federation.preflight()
    if (result.status === "failed")
      yield* Effect.logError("Society provider preflight failed: Societies will not resume without a working provider", {
        reason: result.reason,
        message: result.message,
        action: result.action,
      })
    else if (result.status === "skipped")
      yield* Effect.logWarning("Society provider preflight skipped: Societies resume without a verified provider", {
        reason: result.reason,
      })
    else if (result.warnings.length > 0)
      yield* Effect.logWarning("Society provider preflight passed with warnings", { warnings: result.warnings })
  })
  const resumeAndRecover = reportPreflight.pipe(
    Effect.andThen(
      reportStartupFailure("Failed to hold Societies during server startup", federation.startupHold()),
    ),
  ).pipe(
    Effect.andThen(
      reportStartupFailure(
        "Failed to tick the autoloop cycle during server startup",
        autoloop.execute({ type: "tick", args: [] }).pipe(Effect.asVoid),
      ),
    ),
  ).pipe(
    Effect.andThen(
      reportStartupFailure(
        "Failed to resume suspended sessions during server startup",
        restart.resumeSuspendedSessions,
      ),
    ),
  ).pipe(
    Effect.andThen(
      reportStartupFailure(
        "Failed to recover Orchestra task reports during server startup",
        orchestra.recoverPendingTasks(),
      ),
    ),
  )
  yield* Effect.forkScoped(resumeAndRecover)
})

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname.startsWith("127.") || hostname === "::1" || hostname === "[::1]"
}

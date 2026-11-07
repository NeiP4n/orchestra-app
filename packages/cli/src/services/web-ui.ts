import { FSUtil } from "@orchestra/util/fs-util"
import { Cause, Effect, FileSystem } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import {
  checkSourceStaleness,
  findMissingAssets,
  isWebUiNotBuilt,
  load,
  normalizeAssetKey,
  readTextAsset,
  sourceIndexMtimeMs,
  WEB_UI_NOT_BUILT_MESSAGE,
  type AssetMap,
  type BrotliMap,
} from "../app-assets"
import { ORCHESTRA_LOCAL } from "../version"
import { RECOVERY_PAGE_HTML } from "./recovery-page"

// A 404 without a content-type is what Edge reports as "blocked due to MIME
// type" for module scripts — the browser hides the real 404 behind a MIME
// mystery. Every static 404 therefore says what it is in plain text.
const NOT_FOUND_HEADERS = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }

// Startup and dist-change warnings must reach the terminal `orchestra serve`
// runs in: Effect.logWarning goes to the shared opencode log file (and to
// stderr only with ORCHESTRA_PRINT_LOGS=1), so a broken dist would warn
// where nobody looks. console.error is the serve console's channel — the
// same one "server listening" and the lifecycle lines use, and the one the
// service supervisor captures from `serve --service`.
const warn = (message: string) => Effect.sync(() => console.error(message))

// After `git pull`, rebuild the web app and restart the server: `git pull`
// alone rebuilds neither the app (dist is not in git) nor the installed
// `orchestra` binary.
const REBUILD_HINT =
  "After `git pull`, rebuild the web app with `bun run build` in `packages/app` and restart `orchestra serve` — `git pull` alone does not rebuild the app, and the installed `orchestra` binary does not update itself."

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: {
  readonly assets?: AssetMap
  readonly brotli?: BrotliMap
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed({
        files: options.assets,
        brotli: options.brotli,
        indexHtml: readTextAsset(options.assets, "index.html"),
      })
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))
  // Source mode serves dist from disk, but the map above is loaded once:
  // rebuilding dist while the server runs used to change nothing — the
  // server kept serving the old build until a restart. The snapshot below
  // re-lists dist when index.html changes on disk and swaps the whole map
  // at once, only after the new build validates (every asset the new shell
  // references exists), so a shell and its assets can never come from
  // different builds. A rebuild that is still in progress (or a dist that
  // vanished) keeps the previous build and logs once. Content reads stay
  // lazy, so a swap costs one directory listing plus one stat per request;
  // the embedded (binary) assets are immutable, so no reload applies there.
  let snapshot:
    | { files: AssetMap; brotli: BrotliMap | undefined; indexHtml: string | undefined }
    | undefined
  let snapshotIndexMtimeMs: number | undefined
  let lastReloadAttemptMs = 0
  let warnedIncomplete = false
  const currentSnapshot = () =>
    Effect.gen(function* () {
      const initial = yield* assets.pipe(
        Effect.map((right) => ({ ok: true as const, right })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
      if (initial.ok && snapshot === undefined) snapshot = initial.right
      if (options?.assets !== undefined || !ORCHESTRA_LOCAL) return snapshot
      const now = Date.now()
      if (now - lastReloadAttemptMs < 1000) return snapshot
      lastReloadAttemptMs = now
      // A failed freshness check must never fail the request: keep the old snapshot.
      const stat = () =>
        sourceIndexMtimeMs().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      if (snapshotIndexMtimeMs === undefined && snapshot !== undefined) {
        snapshotIndexMtimeMs = yield* stat()
        return snapshot
      }
      const mtime = yield* stat()
      const changed = snapshot === undefined ? mtime !== undefined : mtime !== undefined && mtime !== snapshotIndexMtimeMs
      if (!changed) return snapshot
      const fresh = yield* load().pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.map((right) => ({ ok: true as const, right })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        // A defect while reloading must not fail the request either: the
        // previous build keeps serving and the failure is logged once.
        Effect.catchCause((cause) =>
          Effect.succeed({ ok: false as const, error: new Error(`Web UI reload failed: ${cause}`) }),
        ),
      )
      if (!fresh.ok) {
        if (!warnedIncomplete) {
          warnedIncomplete = true
          yield* warn(
            isWebUiNotBuilt(fresh.error)
              ? `Web UI dist changed on disk but is not built; keeping the previous build. ${REBUILD_HINT}`
              : `Web UI dist changed on disk but could not be reloaded (${fresh.error}); keeping the previous build.`,
          )
        }
        return snapshot
      }
      const freshIndex = fresh.right.indexHtml
      const missing =
        freshIndex === undefined ? ["index.html"] : findMissingAssets(fresh.right.files, freshIndex)
      if (missing.length > 0) {
        if (!warnedIncomplete) {
          warnedIncomplete = true
          yield* warn(
            `Web UI dist changed on disk but the new build is incomplete (missing: ${missing.slice(0, 5).join(", ")}); keeping the previous build. ${REBUILD_HINT}`,
          )
        }
        return snapshot
      }
      const oldIndex = snapshot?.indexHtml
      snapshot = fresh.right
      snapshotIndexMtimeMs = mtime
      warnedIncomplete = false
      if (oldIndex === undefined)
        yield* warn("Web UI dist appeared on disk; serving the new build without a restart.")
      else if (freshIndex !== undefined && oldIndex !== freshIndex)
        yield* warn("Web UI dist changed on disk (rebuilt); serving the new build without a restart.")
      return snapshot
    })
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      // Serve the web shell before API authentication so a signed-out browser gets the app's sign-in screen.
      // /health is an API route too: it must reach the health handler, never the SPA fallback that used
      // to answer 200 with index.html for it (G2-6).
      if (
        url.pathname === "/api" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/auth/") ||
        url.pathname === "/health" ||
        url.pathname === "/openapi.json"
      )
        return yield* api.pipe(
          Effect.catchIf(isRouteNotFound, () =>
            Effect.succeed(HttpServerResponse.empty({ status: 404, headers: NOT_FOUND_HEADERS })),
          ),
        )
      // The recovery mini-chat is a static page with no build step: it must open even when the
      // main app bundle is broken or was never built, so it never touches the UI assets.
      // /recovery, /recovery/ and /RECOVERY are the same entry: the mini-chat must open from
      // a typed or pasted URL, so the path is matched case-insensitively with an optional slash.
      if (url.pathname.replace(/\/+$/, "").toLowerCase() === "/recovery") {
        if (request.method !== "GET" && request.method !== "HEAD")
          return HttpServerResponse.empty({ status: 405 })
        const recoveryHeaders = {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'self'",
          "x-content-type-options": "nosniff",
        }
        return request.method === "HEAD"
          ? HttpServerResponse.empty({ status: 200, headers: recoveryHeaders })
          : HttpServerResponse.text(RECOVERY_PAGE_HTML, { status: 200, headers: recoveryHeaders })
      }
      // A missing web shell is a build problem, not a missing page: explain it instead of a blank screen.
      const current = yield* currentSnapshot()
      if (current === undefined)
        return yield* assets.pipe(
          Effect.flatMap((loaded) => serveUI(request, url, loaded.files, loaded.brotli, loaded.indexHtml)),
          Effect.catch((error) =>
            isWebUiNotBuilt(error) ? Effect.succeed(webUiNotBuiltResponse()) : Effect.fail(error),
          ),
        )
      return yield* serveUI(request, url, current.files, current.brotli, current.indexHtml)
    })
})

// Loud startup check for `orchestra serve`: a missing or broken dist must
// never be discovered from a blank page in the browser. Call once at server
// startup (server-process.ts); a healthy dist logs nothing. The check itself
// must never fail startup: any failure inside it is logged, and the server
// serves the shell unchecked.
export const checkStartupHealth = Effect.fn("cli.web-ui.checkStartupHealth")(function* () {
  yield* checkStartupHealthInner().pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        console.error(
          `Web UI health check failed; serving the web shell unchecked.
${Cause.pretty(cause)}`,
        ),
      ),
    ),
  )
})

const checkStartupHealthInner = Effect.fn("cli.web-ui.checkStartupHealth.inner")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const loaded = yield* load().pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.map((right) => ({ ok: true as const, right })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  )
  if (!loaded.ok) {
    if (isWebUiNotBuilt(loaded.error)) {
      yield* warn(
        `Web UI is not built: the server will answer the web shell with a 500 page until it is built. ${REBUILD_HINT}`,
      )
    } else {
      yield* warn(
        `Could not load the web UI assets; the server will answer the web shell with a 500 page: ${loaded.error}`,
      )
    }
    return
  }
  const indexHtml = loaded.right.indexHtml
  if (indexHtml === undefined) {
    yield* warn(`Web UI shell is unreadable (index.html is missing or not text). ${REBUILD_HINT}`)
    return
  }
  const missing = findMissingAssets(loaded.right.files, indexHtml)
  if (missing.length > 0) {
    yield* warn(
      `Web UI shell references ${missing.length} missing asset(s) — the page will load broken (blank screen): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}. ${REBUILD_HINT}`,
    )
  }
  if (ORCHESTRA_LOCAL) {
    const staleness = yield* checkSourceStaleness().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
    if (staleness.stale) {
      yield* warn(
        `Web UI dist is stale: ${staleness.newestSource} changed after the last build (dist is not rebuilt by \`git pull\`). ${REBUILD_HINT}`,
      )
    }
  }
})

function serveUI(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  assets: AssetMap,
  brotli: BrotliMap | undefined,
  // The shell text captured when the snapshot was accepted. The source-mode
  // map reads contents lazily from disk, so assets["index.html"] would
  // return whatever is on disk now — a rebuild (or a broken edit) landing
  // after the listing would pair a new shell with the old asset set, and
  // the browser would 404 its chunks even though the reload guard kept the
  // previous build. The captured text is the shell of the build the guard
  // accepted. Hashed assets are content-addressed, so their lazy reads are
  // safe; only the unhashed shell needs the captured text. When no snapshot
  // text exists (a caller-supplied map without index.html), fall back to
  // the map, which then answers with the 500 not-built page.
  indexHtml: string | undefined,
) {
  // A URL path uses forward slashes even when the asset map was built on
  // Windows (see normalizeAssetKey in app-assets.ts).
  const key = normalizeAssetKey(url.pathname.replace(/^\//, ""))
  // A browser that takes brotli gets the embedded bytes as they are, so the server decompresses nothing. The HTML stays
  // decoded, because its CSP hashes the inline theme script.
  const encoded = key !== "index.html" && acceptsBrotli(request.headers["accept-encoding"]) ? brotli?.[key] : undefined
  const requested = encoded ?? assets[key]
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && requested === undefined)
    return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: NOT_FOUND_HEADERS }))
  const name = requested !== undefined ? key : "index.html"
  const file = name === "index.html" && indexHtml !== undefined ? indexHtml : (requested ?? assets["index.html"])
  if (file === undefined) return Effect.succeed(webUiNotBuiltResponse())
  if (request.method !== "GET" && request.method !== "HEAD")
    return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const html = name === "index.html"
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html
      ? cspForHtml(typeof file === "string" ? file : Buffer.from(file).toString())
      : csp(),
    "x-content-type-options": "nosniff",
    ...(!html && brotli?.[name] !== undefined ? { vary: "accept-encoding" } : {}),
    ...(encoded ? { "content-encoding": "br" } : {}),
  }
  return Effect.succeed(
    request.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.raw(file, { headers, contentType: headers["content-type"] }),
  )
}

function webUiNotBuiltResponse() {
  return HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orchestra web UI is not built</title><style>body{font-family:system-ui,sans-serif;margin:40px auto;max-width:560px;padding:0 16px;color:#222}code{background:#f0f0f0;padding:2px 6px;border-radius:4px}</style></head><body><h1>Orchestra web UI is not built</h1><p>${WEB_UI_NOT_BUILT_MESSAGE}</p><p>Run <code>bun run build</code> in <code>packages/app</code>, then restart <code>orchestra serve</code>.</p><p>After <code>git pull</code>, rebuild the app first — <code>git pull</code> alone does not rebuild it, and the installed <code>orchestra</code> binary does not update itself.</p></body></html>`,
    { status: 500, headers: { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'", "x-content-type-options": "nosniff" } },
  )
}

function acceptsBrotli(header: string | undefined) {
  return (header ?? "").split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase())
    return parts[0] === "br" && !parts.slice(1).some((part) => /^q=0(?:\.0*)?$/.test(part))
  })
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

// qr-scanner decodes in a worker it creates from a blob: URL whenever the browser has no BarcodeDetector (Safari, desktop
// Chrome on Windows and Linux). Without worker-src that worker falls under script-src 'self' and never starts.
function csp(hash = "") {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:; worker-src 'self' blob:; frame-ancestors 'self'`
}

function cspForHtml(body: string) {
  const match = body.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])orchestra-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export * as WebUi from "./web-ui"

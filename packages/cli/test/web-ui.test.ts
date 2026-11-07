import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { ServerProcess } from "@orchestra/server/process"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { AppArchive } from "../src/app-archive"
import { sourceAssets } from "../src/app-assets"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  it.live("serves the web shell and assets before server authentication", () =>
    Effect.gen(function* () {
      const transform = yield* WebUi.handler({
        assets: {
          "index.html": "<html><body>connect</body></html>",
          "_assets/app.js": "console.log('connect')",
          "_assets/app.css": "body { color: black; }",
          "icons/icon.svg": "<svg></svg>",
          "font.woff2": new Uint8Array([0, 1, 2, 255]),
          "sw.js": "service worker",
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.forEach(
        [
          "/",
          "/settings",
          "/workspace/example",
          "/_assets/app.js",
          "/_assets/app.css",
          "/icons/icon.svg",
          "/font.woff2",
          "/sw.js",
        ],
        (pathname) =>
          Effect.gen(function* () {
            yield* Effect.forEach(["GET", "HEAD"], (method) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(new URL(pathname, origin), { method }))
                expect(response.status).toBe(200)
                expect(response.headers.get("www-authenticate")).toBeNull()
                yield* Effect.promise(() => response.arrayBuffer())
              }),
            )
          }),
      )
      yield* Effect.forEach(["/api", "/api/info", "/api/event", "/api/missing", "/openapi.json"], (pathname) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => fetch(new URL(pathname, origin)))
          expect(response.status).toBe(401)
          expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
          yield* Effect.promise(() => response.arrayBuffer())
        }),
      )
      // G2-6: /health reaches the API handler without credentials — it must
      // never fall through to the SPA index, which used to answer 200 with
      // HTML for it.
      const health = yield* Effect.promise(() => fetch(new URL("/health", origin)))
      expect(health.status).toBe(200)
      expect(health.headers.get("content-type")).toContain("application/json")
      expect(health.headers.get("www-authenticate")).toBeNull()
      expect((yield* Effect.promise(() => health.json())) as { status: string }).toEqual(
        expect.objectContaining({ status: "ok" }),
      )
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", origin), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toHaveProperty("pid")

      const pairing = yield* Effect.promise(() =>
        fetch(new URL("/api/pair", origin), {
          method: "POST",
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }).then((response) => response.json() as Promise<{ code: string }>),
      )
      const redirect = yield* Effect.promise(() =>
        fetch(new URL(`/auth/connect/${pairing.code}`, origin), {
          redirect: "manual",
          headers: { accept: "text/html" },
        }),
      )
      expect(redirect.status).toBe(302)
      const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0]
      const authorized = yield* Effect.promise(() => fetch(new URL("/api/info", origin), { headers: { cookie } }))
      expect(authorized.status).toBe(200)
      yield* Effect.promise(() => authorized.arrayBuffer())
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  // Б12: the recovery mini-chat page is static and needs no built shell — it
  // must open without credentials even when the main UI was never built.
  it.live("serves the recovery mini-chat page without authentication or a built shell", () =>
    Effect.gen(function* () {
      const transform = yield* WebUi.handler()
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      // T3-9/T3-10: every spelling of the recovery entry serves the mini-chat
      // and refuses to be framed by another site.
      yield* Effect.forEach(["/recovery", "/recovery/", "/RECOVERY", "/Recovery/"], (pathname) =>
        Effect.forEach(["GET", "HEAD"], (method) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() => fetch(new URL(pathname, origin), { method }))
            expect(response.status).toBe(200)
            expect(response.headers.get("www-authenticate")).toBeNull()
            expect(response.headers.get("cache-control")).toBe("no-store")
            expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")
            expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
            if (method === "GET") {
              expect(response.headers.get("content-type")).toContain("text/html")
              const body = yield* Effect.promise(() => response.text())
              expect(body).toContain("восстановление")
              expect(body).toContain("/api/recovery/models")
              expect(body).toContain("/api/recovery/chat")
              // T3-13: the page must not name providers — the empty-list
              // message is generic and the list comes from the API.
              expect(body).not.toContain("klinch/lix")
            } else {
              yield* Effect.promise(() => response.arrayBuffer())
            }
          }),
        ),
      )
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  test("sends embedded brotli bytes as they are to browsers that accept them", async () => {
    const script = "console.log('compressed')".repeat(50)
    const html = "<html><body>compressed</body></html>"
    const brotli = { "_assets/app.js": brotliCompressSync(script), "index.html": brotliCompressSync(html) }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "_assets/app.js": script, "index.html": html }, brotli })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)
          const get = (pathname: string, encoding: string) =>
            Effect.promise(async () => {
              const response = await fetch(`${origin}${pathname}`, {
                headers: { "accept-encoding": encoding },
                decompress: false,
              })
              return { headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) }
            })

          const encoded = yield* get("/_assets/app.js", "gzip, deflate, br")
          expect(encoded.headers.get("content-encoding")).toBe("br")
          expect(encoded.headers.get("vary")).toBe("accept-encoding")
          expect(encoded.headers.get("content-type")).toContain("javascript")
          expect(encoded.body).toEqual(new Uint8Array(brotli["_assets/app.js"]))

          yield* Effect.forEach(["gzip", "br;q=0"], (encoding) =>
            Effect.gen(function* () {
              const plain = yield* get("/_assets/app.js", encoding)
              expect(plain.headers.get("content-encoding")).toBeNull()
              expect(plain.headers.get("vary")).toBe("accept-encoding")
              expect(new TextDecoder().decode(plain.body)).toBe(script)
            }),
          )

          const page = yield* get("/", "br")
          expect(page.headers.get("content-encoding")).toBeNull()
          expect(new TextDecoder().decode(page.body)).toBe(html)
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    await writeFile(index, "<html><body>embedded</body></html>")
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/info")
                  return HttpServerResponse.jsonUnsafe({
                    version: "test",
                    pid: 1,
                    urls: [origin],
                    paths: { tmp: "/tmp/orchestra" },
                  })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const status = yield* Effect.promise(() => fetch(`${origin}/api/info`))
          expect(yield* Effect.promise(() => status.json())).toEqual({
            version: "test",
            pid: 1,
            urls: [origin],
            paths: { tmp: "/tmp/orchestra" },
          })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          // A 404 without a content-type is what Edge reports as "blocked
          // due to MIME type" for module scripts — the browser must see a
          // plain-text 404, not a MIME mystery.
          expect(missing.headers.get("content-type")).toContain("text/plain")
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(missing.headers.get("content-type")).toContain("text/plain")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")
          expect(fallback.headers.get("content-security-policy")).toContain("worker-src 'self' blob:")
          expect(fallback.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("serves nested assets whose map keys use Windows backslash separators", async () => {
    // Windows-only white screen: a Windows server's readdir lists nested
    // files with backslashes (`_assets\index-abc.js`), so the asset map's
    // keys never matched a URL lookup and every nested asset 404'd while
    // index.html loaded fine. The map here is built the way the packaged
    // server builds it — through AppArchive.decode — so the lookup must
    // find the file by its URL key.
    const decoded = AppArchive.decode(
      AppArchive.encode([
        ["index.html", new TextEncoder().encode("<html><body>windows</body></html>")],
        ["_assets\\app.js", new TextEncoder().encode("console.log('windows')")],
        ["icons\\dev\\favicon.ico", new Uint8Array([1, 2, 3])],
      ] as const),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: decoded })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(script.status).toBe(200)
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('windows')")

          const icon = yield* Effect.promise(() => fetch(`${origin}/icons/dev/favicon.ico`))
          expect(icon.status).toBe(200)
          expect(new Uint8Array(yield* Effect.promise(() => icon.arrayBuffer()))).toEqual(
            new Uint8Array([1, 2, 3]),
          )
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("serves the shell text from the accepted snapshot, not a later disk edit", async () => {
    // sourceAssets reads file contents lazily from disk, so overwriting
    // index.html after the handler loaded used to change the served shell
    // at once: a rebuild (or a broken edit) landing mid-flight paired a
    // new shell with the old asset set, and the browser 404'd its chunks
    // even though the reload guard had kept the previous build. The served
    // shell must be the text captured when the snapshot was accepted.
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-shell-"))
    try {
      const good = `<html><head><script src="/_assets/app.js" type="module"></script></head><body>good shell</body></html>`
      const broken = `<html><head><script src="/_assets/app-DEAD.js" type="module"></script></head><body>broken shell</body></html>`
      await mkdir(path.join(dir, "_assets"), { recursive: true })
      await writeFile(path.join(dir, "index.html"), good)
      await writeFile(path.join(dir, "_assets", "app.js"), "console.log('app')")
      const files = await Effect.runPromise(sourceAssets(dir).pipe(Effect.provide(NodeFileSystem.layer)))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transform = yield* WebUi.handler({ assets: files })
            const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
            yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
            const origin = HttpServer.formatAddress(http.address)

            const first = yield* Effect.promise(() => fetch(`${origin}/`))
            expect(yield* Effect.promise(() => first.text())).toContain("good shell")

            yield* Effect.promise(() => writeFile(path.join(dir, "index.html"), broken))
            const second = yield* Effect.promise(() => fetch(`${origin}/`))
            const served = yield* Effect.promise(() => second.text())
            expect(served).toContain("good shell")
            expect(served).not.toContain("broken shell")
          }),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("serves index.html with an external theme preload script without a CSP hash and serves the preload file", async () => {
    // The source index.html references the theme preload as an external
    // file (script-src 'self' covers it), so the CSP carries no sha256
    // hash here — a hash is only added for the inline script the vite
    // build produces (see the next test).
    const index =
      '<!doctype html><html><head><script id="orchestra-theme-preload-script" src="/orchestra-theme-preload.js"></script></head><body>app</body></html>'
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({
            assets: {
              "index.html": index,
              "orchestra-theme-preload.js": "document.documentElement.dataset.theme='dark'",
            },
          })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)

          const page = yield* Effect.promise(() => fetch(`${origin}/`))
          expect(page.status).toBe(200)
          const csp = page.headers.get("content-security-policy") ?? ""
          expect(csp).toContain("script-src 'self'")
          expect(csp).not.toContain("sha256-")
          expect(csp).toContain("frame-ancestors 'self'")
          expect(yield* Effect.promise(() => page.text())).toContain("orchestra-theme-preload.js")

          const preload = yield* Effect.promise(() => fetch(`${origin}/orchestra-theme-preload.js`))
          expect(preload.status).toBe(200)
          expect(yield* Effect.promise(() => preload.text())).toContain("dataset.theme")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("hashes the inline theme preload script in built HTML so the browser runs it", async () => {
    // The vite build inlines the theme preload into index.html
    // (packages/app/vite.js: inlineThemePreload), so the served HTML
    // carries an inline script — the CSP must hash its exact content,
    // or the browser blocks it under script-src 'self'. Removing the
    // hash (arch3 №7a as first written) would break the built app.
    const inlineScript = "document.documentElement.dataset.theme='dark'"
    const index =
      `<!doctype html><html><head><script id="orchestra-theme-preload-script">${inlineScript}</script></head><body>app</body></html>`
    const expectedHash = createHash("sha256").update(inlineScript).digest("base64")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "index.html": index } })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)

          const page = yield* Effect.promise(() => fetch(`${origin}/`))
          expect(page.status).toBe(200)
          const csp = page.headers.get("content-security-policy") ?? ""
          expect(csp).toContain(`'sha256-${expectedHash}'`)
          expect(csp).toContain("frame-ancestors 'self'")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("returns a clear 500 error page instead of an empty 404 when the web shell was never built", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: {} })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)

          yield* Effect.forEach(["/", "/workspace/example"], (pathname) =>
            Effect.gen(function* () {
              const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(response.status).toBe(500)
              expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
              const body = yield* Effect.promise(() => response.text())
              expect(body).toContain("Web UI is not built")
              expect(body).toContain("bun run build")
              expect(body).toContain("packages/app")
            }),
          )
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })
})


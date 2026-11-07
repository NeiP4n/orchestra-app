import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { VitePWA } from "vite-plugin-pwa"

// The Office previews' engines and fonts (about 52 MB) load only when an Office file opens, so they stay out of the
// precache. The app's own fonts have no hyphenated name, such as `assets/Inter.ttf`.
const officeAsset =
  /(?:^|\/)(?:(?:docx_\w+|ooxml_opc|pptx_wasm|xlsx_wasm)_bg-[\w-]+\.wasm|residentEngineWorker-[\w-]+\.js|(?:Carlito|Caladea|LiberationSans|LiberationSerif|LiberationMono|NotoSansArabic|NotoNaskhArabic|NotoSansHebrew|Gelasio|ComicRelief|Inter|Roboto|SourceSans3|DMSans|DMSerifDisplay|OpenSans|Montserrat|Poppins|Oswald|Heebo)-[\w-]+\.ttf)$/

/** Whether a built file loads on demand instead of being precached. */
export function onDemandAsset(path: string) {
  return officeAsset.test(path)
}

export function serviceWorker(directory: string) {
  return VitePWA({
    strategies: "generateSW",
    registerType: "prompt",
    injectRegister: false,
    manifest: false,
    workbox: {
      // Workbox runs after Sentry's upload and cleanup, so do not publish an unuploaded map.
      sourcemap: false,
      globDirectory: directory,
      clientsClaim: false,
      // Keep each open tab on its complete build until all old clients close:
      // a new service worker taking over mid-session would make the tab's
      // next lazy chunk miss the new precache and 404 against the new dist.
      // Freshness does not depend on the takeover: the shell is never
      // precached (see globIgnores) and every navigation fetches it from
      // the server first (see runtimeCaching), so a reload always gets the
      // current shell even while the old worker still controls the page.
      skipWaiting: false,
      inlineWorkboxRuntime: true,
      // vite-plugin-pwa defaults navigateFallback to "index.html": without
      // an explicit undefined here, the generated worker registers a
      // navigation route bound to the precached shell — registered before
      // the runtimeCaching route below, so it would swallow every
      // navigation and serve (or fail to serve) the shell from the cache.
      navigateFallback: undefined,
      // The shell is deliberately NOT precached: a precached index.html is
      // a shell from the build that installed the worker, served without
      // ever asking the server — when dist was rebuilt since, its hashed
      // assets are gone and the page loads white with 404s. Navigations
      // fetch the current shell from the network and fall back to the
      // cached shell only when the server is unreachable (in which case the
      // app cannot work anyway: the API is same-origin). Hashed assets stay
      // precached: their content-addressed names cannot go stale.
      // Pairing links must reach the server so it can set the session cookie.
      runtimeCaching: [
        {
          urlPattern: ({ request, url }) =>
            request.mode === "navigate" && !/^\/(?:api|auth)(?:\/|$)/.test(url.pathname),
          handler: "NetworkFirst",
          options: {
            cacheName: "orchestra-shell",
            networkTimeoutSeconds: 3,
            cacheableResponse: { statuses: [200] },
          },
        },
      ],
      // Include lazy chunks and non-JS dependencies, not just the startup bundle.
      globPatterns: ["**/*"],
      globIgnores: ["**/*.map", "_headers", "_redirects", "index.html"],
      maximumFileSizeToCacheInBytes: Number.MAX_SAFE_INTEGER,
      manifestTransforms: [
        async (entries) => ({
          manifest: await Promise.all(
            entries
              .filter((entry) => !onDemandAsset(entry.url))
              .map(async (entry) => ({
              ...entry,
              // A revision labels a cache entry; integrity rejects mixed deployments
              // and HTML fallback responses instead of installing a broken build.
              integrity: `sha256-${createHash("sha256")
                .update(await readFile(resolve(directory, entry.url)))
                .digest("base64")}`,
            })),
          ),
          warnings: [],
        }),
      ],
    },
  })
}

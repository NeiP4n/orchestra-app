import { Effect, FileSystem, Option } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { AppArchive } from "./app-archive"
import { ORCHESTRA_LOCAL } from "./version"

export type AssetMap = Readonly<Record<string, string | Uint8Array>>
/** Each asset's brotli-compressed bytes, when the build embedded them. */
export type BrotliMap = Readonly<Record<string, Uint8Array>>

/** The web shell's build output: the source-mode server reads it from disk, the packaged CLI embeds it. */
export const sourceDistDir = path.resolve(import.meta.dirname, "../../app/dist")

// Node's recursive readdir returns paths with the platform separator:
// `_assets/index-abc.js` on Linux, `_assets\index-abc.js` on Windows.
// URL lookups always use forward slashes, so a Windows server built its
// asset map with keys no URL could ever match — every nested asset 404'd
// while index.html (no separator in its name) loaded fine, and the browser
// showed a white page (Edge reports the empty 404 as "MIME-type blocked").
// Normalize backslashes on every platform: on Linux a backslash is also
// just a filename character, so the same rule covers a Windows-shaped map
// built anywhere. Keys are normalized; filesystem paths (values) are not.
export function normalizeAssetKey(key: string) {
  return key.replaceAll("\\", "/")
}

/** Shown (and thrown) when the web shell was never built, so serve explains instead of showing a blank page. */
export const WEB_UI_NOT_BUILT_MESSAGE =
  "Web UI is not built. Run bun run build in packages/app, then restart orchestra serve."

export function isWebUiNotBuilt(error: unknown) {
  return error instanceof Error && error.message === WEB_UI_NOT_BUILT_MESSAGE
}

export const load = Effect.fn("cli.app-assets.load")(function* () {
  const embedded = yield* Effect.tryPromise(() => import("virtual:orchestra-app-assets")).pipe(
    Effect.map((module) => AppArchive.decode(module.default())),
    Effect.option,
  )
  if (Option.isSome(embedded)) {
    if (Object.keys(embedded.value).length === 0)
      return yield* Effect.fail(new Error(WEB_UI_NOT_BUILT_MESSAGE))
    const files = lazy(embedded.value, (key) => brotliDecompressSync(embedded.value[key]!))
    // The shell text is captured with the listing: the map reads contents
    // lazily from disk, so reading index.html later could return bytes from
    // a rebuild that landed after the listing — a shell validated against a
    // key set from a different build. A snapshot is one listing plus the
    // shell text read at that moment.
    return { files, brotli: embedded.value, indexHtml: readTextAsset(files, "index.html") }
  }
  if (!ORCHESTRA_LOCAL) return yield* Effect.fail(new Error(WEB_UI_NOT_BUILT_MESSAGE))
  const files = yield* sourceAssets()
  return { files, brotli: undefined, indexHtml: readTextAsset(files, "index.html") }
})

export const sourceAssets = Effect.fnUntraced(function* (root: string = sourceDistDir) {
  const fs = yield* FileSystem.FileSystem
  const files = yield* fs.readDirectory(root, { recursive: true }).pipe(
    Effect.mapError((cause) => new Error(WEB_UI_NOT_BUILT_MESSAGE, { cause })),
  )
  const assets = Object.fromEntries(
    (yield* Effect.forEach(
      files.filter((file) => !file.endsWith(".map")),
      Effect.fnUntraced(function* (file) {
        const target = path.join(root, file)
        if ((yield* fs.stat(target)).type === "Directory") return
        // The key is a URL path, never a filesystem path (see normalizeAssetKey).
        return [normalizeAssetKey(file), target] as const
      }),
      { concurrency: "unbounded" },
    )).filter((asset) => asset !== undefined),
  )
  return lazy(assets, (key) => readFileSync(assets[key]!))
})

function lazy(assets: Readonly<Record<string, unknown>>, load: (key: string) => Uint8Array): AssetMap {
  // Immutable browser caching makes retaining decompressed copies in the server unnecessary.
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (typeof key !== "string" || assets[key] === undefined) return
        const body = load(key)
        return isText(key) ? Buffer.from(body).toString() : body
      },
    },
  )
}

function isText(file: string) {
  return file === "_headers" || /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/.test(file)
}

// Local same-origin references in the shell: <script src="/_assets/...">,
// <link href="/_assets/...">, the manifest, icons. External URLs,
// protocol-relative URLs and API paths are not files the server must have.
export function referencedAssets(indexHtml: string) {
  const refs = new Set<string>()
  for (const match of indexHtml.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = match[1].split(/[?#]/, 1)[0]
    if (!ref.startsWith("/") || ref.startsWith("//")) continue
    if (ref === "/" || ref.startsWith("/api/") || ref.startsWith("/auth/")) continue
    refs.add(normalizeAssetKey(ref.replace(/^\//, "")))
  }
  return [...refs].sort()
}

function assetPresent(files: AssetMap, ref: string) {
  try {
    return files[ref] !== undefined
  } catch {
    // A file listed in the map but unreadable (deleted mid-rebuild) is
    // missing for the browser's purposes.
    return false
  }
}

/** Shell references the server cannot serve: the page loads broken. */
export function findMissingAssets(files: AssetMap, indexHtml: string) {
  return referencedAssets(indexHtml).filter((ref) => !assetPresent(files, ref))
}

/** The shell's text, when the map holds it (a missing/unreadable shell is not text). */
export function readTextAsset(files: AssetMap, key: string) {
  try {
    const file = files[key]
    return typeof file === "string" ? file : undefined
  } catch {
    return undefined
  }
}

// @effect/platform's FileInfo carries mtime as Option<Date> (absent on
// filesystems that do not report one), not a bare Date.
function mtimeMs(stat: { readonly mtime: Option.Option<Date> }) {
  return Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : undefined
}

/** index.html's modification time in the source dist, when it exists. */
export const sourceIndexMtimeMs = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const stat = yield* fs.stat(path.join(sourceDistDir, "index.html")).pipe(Effect.option)
  return Option.isNone(stat) ? undefined : mtimeMs(stat.value)
})

// Source mode only: is the dist older than the app sources it was built
// from? `git pull` never rebuilds dist (it is not in git), so a stale dist
// silently serves the previous build until someone rebuilds and restarts.
export const checkSourceStaleness = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const appDir = path.resolve(import.meta.dirname, "../../app")
  const distStat = yield* fs.stat(path.join(sourceDistDir, "index.html")).pipe(Effect.option)
  if (Option.isNone(distStat)) return { stale: false, distMtimeMs: undefined as number | undefined }
  const distMtimeMs = mtimeMs(distStat.value)
  if (distMtimeMs === undefined) return { stale: false, distMtimeMs: undefined as number | undefined }
  const mtimeOf = Effect.fnUntraced(function* (target: string) {
    const stat = yield* fs.stat(target).pipe(Effect.option)
    return Option.isNone(stat) || stat.value.type !== "File" ? undefined : mtimeMs(stat.value)
  })
  const scanDir = Effect.fnUntraced(function* (dir: string) {
    const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.option)
    if (Option.isNone(entries)) return [] as Array<readonly [string, number]>
    return (yield* Effect.forEach(
      entries.value,
      Effect.fnUntraced(function* (entry) {
        const target = path.join(dir, entry)
        const modified = yield* mtimeOf(target)
        return modified === undefined ? undefined : ([path.relative(appDir, target), modified] as const)
      }),
      { concurrency: "unbounded" },
    )).flatMap((entry) => (entry === undefined ? [] : [entry]))
  })
  const candidates = [
    ...(yield* scanDir(path.join(appDir, "src"))),
    ...(yield* scanDir(path.join(appDir, "public"))),
    ...((yield* Effect.forEach(
      ["index.html", "package.json", "vite.config.ts", "vite.pwa.ts", "vite.js", "vite.icons.ts"],
      Effect.fnUntraced(function* (entry) {
        const modified = yield* mtimeOf(path.join(appDir, entry))
        return modified === undefined ? undefined : ([entry, modified] as const)
      }),
      { concurrency: "unbounded" },
    )).flatMap((entry) => (entry === undefined ? [] : [entry]))),
  ]
  const newest = candidates.reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ["", 0] as readonly [string, number],
  )
  return {
    stale: newest[1] > distMtimeMs,
    distMtimeMs,
    newestSource: newest[1] === 0 ? undefined : newest[0],
    newestSourceMtimeMs: newest[1] === 0 ? undefined : newest[1],
  }
})

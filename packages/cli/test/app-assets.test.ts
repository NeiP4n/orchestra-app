import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  findMissingAssets,
  normalizeAssetKey,
  referencedAssets,
  sourceAssets,
  WEB_UI_NOT_BUILT_MESSAGE,
} from "../src/app-assets"

// These two suites write files whose NAMES contain a literal backslash to
// simulate a Windows-style readdir listing - only POSIX allows that.
const posixTest = process.platform === "win32" ? test.skip : test

describe("web UI assets", () => {
  test("normalizeAssetKey turns Windows separators into URL slashes", () => {
    expect(normalizeAssetKey("_assets\\index-abc.js")).toBe("_assets/index-abc.js")
    expect(normalizeAssetKey("icons\\dev\\favicon.ico")).toBe("icons/dev/favicon.ico")
    expect(normalizeAssetKey("_assets/app.js")).toBe("_assets/app.js")
    expect(normalizeAssetKey("index.html")).toBe("index.html")
  })

  test("referencedAssets lists only the local files the shell needs", () => {
    const index = `<!doctype html><html><head>
      <script src="/orchestra-boot.js"></script>
      <script src="/_assets/index-abc.js" type="module"></script>
      <link href="/_assets/index-def.css" rel="stylesheet">
      <link href="https://example.com/font.css" rel="stylesheet">
      <link href="//cdn.example.com/x.css" rel="stylesheet">
      <link rel="manifest" href="/site.webmanifest?v=2">
      <script src="/api/nope.js"></script>
    </head><body>app</body></html>`

    expect(referencedAssets(index)).toEqual([
      "_assets/index-abc.js",
      "_assets/index-def.css",
      "orchestra-boot.js",
      "site.webmanifest",
    ])
  })

  test("findMissingAssets names the shell references the server cannot serve", () => {
    const index = `<html><head>
      <script src="/_assets/index-abc.js" type="module"></script>
      <link href="/_assets/index-def.css" rel="stylesheet">
      <link href="/_assets/missing.css" rel="stylesheet">
    </head><body>app</body></html>`
    const files = {
      "index.html": index,
      "_assets/index-abc.js": "console.log(1)",
      "_assets/index-def.css": "body{}",
    }

    expect(findMissingAssets(files, index)).toEqual(["_assets/missing.css"])
    expect(findMissingAssets({ ...files, "_assets/missing.css": "x" }, index)).toEqual([])
  })

  posixTest("sourceAssets resolves nested files when the listing uses Windows backslash separators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-assets-"))
    try {
      // On Linux a backslash is a legal filename character, so a file
      // literally named `_assets\app.js` makes readdir return exactly what
      // Windows returns for the nested file `_assets/app.js` — the shape
      // that used to 404 every nested asset on a Windows server while
      // index.html loaded fine.
      await writeFile(path.join(root, "index.html"), "<html></html>")
      await writeFile(path.join(root, "_assets\\app.js"), "console.log('windows')")
      await writeFile(path.join(root, "_assets\\app.css"), "body{}")
      const files = await Effect.runPromise(sourceAssets(root).pipe(Effect.provide(NodeFileSystem.layer)))

      expect(files["_assets/app.js"]).toBe("console.log('windows')")
      expect(files["_assets/app.css"]).toBe("body{}")
      expect(files["index.html"]).toBe("<html></html>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  posixTest("sourceAssets skips sourcemaps and fails clearly when the dist is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-assets-"))
    try {
      await writeFile(path.join(root, "index.html"), "<html></html>")
      await writeFile(path.join(root, "_assets\\app.js"), "console.log(1)")
      await writeFile(path.join(root, "_assets\\app.js.map"), "{}")
      const files = await Effect.runPromise(sourceAssets(root).pipe(Effect.provide(NodeFileSystem.layer)))

      expect(files["_assets/app.js"]).toBe("console.log(1)")
      expect(files["_assets/app.js.map"]).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const missing = await Effect.runPromise(
      sourceAssets(path.join(tmpdir(), "opencode-web-ui-assets-definitely-missing")).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.flip,
      ),
    )
    expect((missing as Error).message).toBe(WEB_UI_NOT_BUILT_MESSAGE)
  })
})

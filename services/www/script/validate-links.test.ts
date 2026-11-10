import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateLocalLinks } from "./validate-links"

test("validates relative, local anchors, encoded targets and every repeated missing link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "www-links-"))
  try {
    await mkdir(path.join(root, "guide"))
    await writeFile(
      path.join(root, "index.html"),
      `<a href="/guide/#good">good</a><a href="/guide/#bad">bad anchor</a><a href="/missing">missing</a><a href="/missing">duplicate</a><a href="/docs">external docs</a><a href="https://example.org/nope">external</a><a href="/space%20name.html#ok">encoded</a>`,
    )
    await writeFile(
      path.join(root, "guide/index.html"),
      `<h1 id="good">Guide</h1><a href="../#home">home</a><a href="/absent">missing</a>`,
    )
    await writeFile(path.join(root, "space name.html"), '<h1 id="ok">OK</h1>')
    expect(await validateLocalLinks(root)).toEqual([
      "guide/index.html: missing /#home",
      "guide/index.html: missing /absent",
      "index.html: missing /guide/#bad",
      "index.html: missing /missing",
    ])
    await writeFile(path.join(root, "index.html"), '<h1 id="home">Home</h1><a href="/guide/#good">valid</a>')
    await writeFile(path.join(root, "guide/index.html"), '<h1 id="good">Guide</h1><a href="../#home">valid</a>')
    expect(await validateLocalLinks(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

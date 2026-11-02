import { $ } from "bun"
import { readFile, writeFile } from "node:fs/promises"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`

const dest = "resources/icons"

await $`rm -rf ${dest}`

await $`cp -R ${src} ${dest}`

console.log(`Copied ${channel} icons from ${src} to ${dest}`)

// Workaround for text-only publishing: the GitHub snapshot push accepts
// UTF-8 text only, so the binary icon files cannot be pushed that way.
// The orchestra mark instead lives in the repo as base64 text
// (icons/orchestra-mark.png.base64), and this script — which already runs
// on every dev start (scripts/dev.ts) and before packaging
// (scripts/prebuild.ts) — decodes it into the real files the app and
// electron-builder read from resources/icons. If the base64 source is
// absent, the copied channel icons are left untouched.
const markPath = "./icons/orchestra-mark.png.base64"

const encoded = await readFile(markPath, "utf8").catch(() => undefined)

if (encoded) {
  const png = Buffer.from(
    encoded
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join(""),
    "base64",
  )

  if (png.length > 0) {
    await writeFile(`${dest}/icon.png`, png)
    await writeFile(`${dest}/dock.png`, png)
    await writeFile(`${dest}/icon.ico`, pngToIco(png))
    console.log(`Generated orchestra icons in ${dest} from ${markPath}`)
  }
}

// Minimal ICO writer: a single 256x256 entry whose image data is the PNG
// itself. Windows decodes PNG-compressed ICO entries and scales them,
// so one entry covers the window, taskbar and installer icons.
function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(6 + 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  // Entry: 256x256 (0 means 256), 0 colors, 0 reserved, 1 plane, 32 bpp,
  // size and offset of the PNG data that follows the directory.
  header.writeUInt8(0, 6)
  header.writeUInt8(0, 7)
  header.writeUInt8(0, 8)
  header.writeUInt8(0, 9)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(header.length, 18)

  return Buffer.concat([header, png])
}

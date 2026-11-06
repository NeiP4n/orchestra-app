import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyBuiltCliToResources, getCurrentCli } from "./utils"

// The desktop embeds the locally built CLI (ORCHESTRA_CLI_DIST): prebuild copies
// <dist>/<package>/bin/orchestra[.exe] into resources/. A build that writes the binary
// under any other name must fail loudly here, not at packaging time.
test("copyBuiltCliToResources embeds the built orchestra binary and its version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cli-dist-"))
  try {
    const cli = getCurrentCli()
    const pkgDir = path.join(root, cli.package.replace("@orchestra/", ""))
    const binary = cli.os === "win32" ? "orchestra.exe" : "orchestra"
    await mkdir(path.join(pkgDir, "bin"), { recursive: true })
    await writeFile(path.join(pkgDir, "bin", binary), "#!/bin/sh\necho orchestra\n")
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: cli.package, version: "9.9.9" }))
    const dest = path.join(root, "resources", "orchestra-cli")
    await mkdir(path.dirname(dest), { recursive: true })
    await copyBuiltCliToResources(root, dest)
    expect(await Bun.file(dest).text()).toContain("echo orchestra")
    expect(await Bun.file(path.join(root, "resources", "orchestra-cli.version")).text()).toBe("9.9.9")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

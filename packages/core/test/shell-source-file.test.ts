import { expect, test } from "bun:test"
import { readFile, stat, readdir } from "node:fs/promises"
import path from "node:path"
import { ShellSourceFile } from "../src/shell/source-file"

test("Nushell parser source is private, unique, exact and removable", async () => {
  const source = await ShellSourceFile.create("print 'temporary command'")
  const other = await ShellSourceFile.create("different")
  try {
    expect(source.file).not.toBe(other.file)
    expect(await readFile(source.file, "utf8")).toBe("print 'temporary command'")
    expect(await readdir(path.dirname(source.file))).toEqual(["source.nu"])
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(source.file))).mode & 0o777).toBe(0o700)
      expect((await stat(source.file)).mode & 0o777).toBe(0o600)
    }
  } finally {
    await source.dispose()
    await other.dispose()
  }
  await expect(stat(source.file)).rejects.toThrow()
  await expect(stat(path.dirname(source.file))).rejects.toThrow()
})

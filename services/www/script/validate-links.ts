import path from "node:path"

/** Check every local link, caching immutable build output instead of reading it once per link. */
export async function validateLocalLinks(root: string) {
  const externalRoutes = new Set(["/docs"])
  const text = new Map<string, Promise<string>>()
  const exists = new Map<string, Promise<boolean>>()
  const read = (file: string) => {
    if (!text.has(file)) text.set(file, Bun.file(file).text())
    return text.get(file)!
  }
  const has = (file: string) => {
    if (!exists.has(file)) exists.set(file, Bun.file(file).exists())
    return exists.get(file)!
  }
  const failures = new Set<string>()
  // Bound live work to one page and one link at a time. A large shared nav must not multiply memory use.
  for await (const file of new Bun.Glob("**/*.html").scan({ cwd: root, absolute: true })) {
    const html = await read(file)
    const page = `https://opencode.local/${path.relative(root, file).replace(/index\.html$/, "")}`
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(match[1], page)
      if (url.origin !== "https://opencode.local" || externalRoutes.has(url.pathname)) continue
      const targetPath = path.join(root, decodeURIComponent(url.pathname))
      let target: string | undefined
      for (const candidate of [targetPath, path.join(targetPath, "index.html"), `${targetPath}.html`]) {
        if (await has(candidate)) {
          target = candidate
          break
        }
      }
      if (!target) {
        failures.add(`${path.relative(root, file)}: missing ${url.pathname}`)
        continue
      }
      if (!url.hash || !target.endsWith(".html")) continue
      const id = decodeURIComponent(url.hash.slice(1))
      if (!(await read(target)).includes(`id="${id}"`))
        failures.add(`${path.relative(root, file)}: missing ${url.pathname}${url.hash}`)
    }
  }
  return [...failures].sort()
}

if (import.meta.main) {
  const failures = await validateLocalLinks(path.resolve(import.meta.dir, "../dist/client"))
  if (failures.length) console.error(failures.join("\n"))
  process.exit(failures.length ? 1 : 0)
}

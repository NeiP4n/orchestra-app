import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orchestra/util/global"
import { Effect } from "effect"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

test("an unreadable service credential config never silently rotates the signing password", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-config-recovery-"))
  const config = path.join(root, "config")
  const layer = Global.layerWith({ config, state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | import("effect").FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    await run(ServiceConfig.password())
    const file = path.join(config, ServiceConfig.filename())
    await fs.writeFile(file, "{corrupted")
    await expect(run(ServiceConfig.password())).rejects.toThrow()
    expect(await fs.readFile(file, "utf8")).toBe("{corrupted")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a directory in place of service config fails closed without replacing its contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-config-directory-"))
  const config = path.join(root, "config")
  const layer = Global.layerWith({ config, state: path.join(root, "state") })
  try {
    const file = path.join(config, ServiceConfig.filename())
    await fs.mkdir(file, { recursive: true })
    await expect(
      Effect.runPromise(ServiceConfig.password().pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer))),
    ).rejects.toThrow()
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("fresh startup credentials remain stable and keep a browser session valid across reloads", async () => {
  const { ServerAuth } = await import("@orchestra/server/auth")
  const { Option } = await import("effect")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-config-session-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const password = () =>
    Effect.runPromise(ServiceConfig.password().pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    const first = await password()
    const session = ServerAuth.issueSession({ username: "orchestra", password: Option.some(first) })!
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await password()
      expect(next === first).toBe(true)
      expect(ServerAuth.verifySession(session, { username: "orchestra", password: Option.some(next) })).toBe(true)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

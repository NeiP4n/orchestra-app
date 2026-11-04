import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Duration, Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceClaim } from "../src/services/service-claim"

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

async function registrationFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-service-claim-"))
  return { directory, file: path.join(directory, "service-local.json") }
}

/** A pid that is guaranteed dead: a child that already exited. */
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

test("claim is exclusive and release only removes the owner's claim", async () => {
  const { directory, file } = await registrationFile()
  try {
    expect(await run(ServiceClaim.claim(file))).toBe(true)
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
    // A second claim by anyone — including this process — loses while the file exists.
    expect(await run(ServiceClaim.claim(file))).toBe(false)

    await run(ServiceClaim.release(file))
    expect(await run(ServiceClaim.holder(file))).toBeUndefined()
    expect(await fs.readdir(directory)).toEqual([])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("acquire claims immediately when startup is unowned", async () => {
  const { directory, file } = await registrationFile()
  try {
    expect(await run(ServiceClaim.acquire({ file }))).toBe("claimed")
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
    await run(ServiceClaim.release(file))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("acquire yields as soon as the holder's incumbent is visible", async () => {
  const { directory, file } = await registrationFile()
  try {
    // A live holder (this process stands in for it) that has finished starting.
    await fs.writeFile(ServiceClaim.claimFile(file), String(process.pid))
    const verdict = await run(
      ServiceClaim.acquire({ file, incumbent: Effect.succeed(true), timeout: Duration.seconds(5), poll: Duration.millis(10) }),
    )
    expect(verdict).toBe("yield")
    // The holder's claim is left untouched.
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("acquire reclaims a dead holder's claim", async () => {
  const { directory, file } = await registrationFile()
  try {
    await fs.writeFile(ServiceClaim.claimFile(file), String(await deadPid()))
    const verdict = await run(ServiceClaim.acquire({ file, timeout: Duration.seconds(5), poll: Duration.millis(10) }))
    expect(verdict).toBe("claimed")
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
    await run(ServiceClaim.release(file))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("acquire takes over a live holder that never registers", async () => {
  const { directory, file } = await registrationFile()
  try {
    await fs.writeFile(ServiceClaim.claimFile(file), String(process.pid))
    const verdict = await run(
      ServiceClaim.acquire({ file, incumbent: Effect.succeed(false), timeout: Duration.millis(300), poll: Duration.millis(10) }),
    )
    expect(verdict).toBe("claimed")
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
    await run(ServiceClaim.release(file))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("acquire yields to a live holder whose registration exists", async () => {
  const { directory, file } = await registrationFile()
  try {
    await fs.writeFile(ServiceClaim.claimFile(file), String(process.pid))
    await fs.writeFile(file, "{}")
    const verdict = await run(
      ServiceClaim.acquire({ file, incumbent: Effect.succeed(false), timeout: Duration.millis(300), poll: Duration.millis(10) }),
    )
    expect(verdict).toBe("yield")
    expect(await run(ServiceClaim.holder(file))).toBe(process.pid)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

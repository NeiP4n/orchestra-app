import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Flock } from "@orchestra/util/flock"
import { ProjectTemplateV2Library as Library } from "../src/project-template-v2-library"
import { ProjectTemplateV2 as Codec } from "../src/project-template-v2"
import { processFixture } from "./project-template-v2.test"

test("actual killed template writer leaves a complete reviewed manifest and recovers its stale process lock", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "template-kill-restart-")))
  Flock.setGlobal({ state: path.join(root, "state") })
  const baseline = Codec.preview(JSON.stringify(processFixture()))
  if (!baseline.ok) throw Error(baseline.error)
  const changed = processFixture()
  changed.process.playbook = "Reviewed alternate process for crash recovery."
  const alternate = Codec.preview(JSON.stringify(changed))
  if (!alternate.ok) throw Error(alternate.error)
  const library = Library.local(root)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await library.saveSerialized(baseline.value.text, "factory", baseline.value.digest)
    await writeFile(path.join(root, "first.json"), alternate.value.text)
    await writeFile(path.join(root, "second.json"), baseline.value.text)
    child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixture/template-replace-process.ts", import.meta.url)), root], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = child.stdout
    if (typeof output === "number" || !output) throw Error("Missing child process readiness stream")
    const reader = output.getReader()
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain("UPDATE_COMMITTED")
    // The child keeps calling the real disk-backed replacement and lock while it is terminated.
    await Bun.sleep(10)
    child.kill("SIGKILL")
    expect(await child.exited).not.toBe(0)
    const restarted = Library.local(root)
    const recovered = await restarted.preview("factory")
    expect([baseline.value.digest, alternate.value.digest]).toContain(recovered.digest)
    expect(await restarted.list()).toEqual([
      { id: "factory", state: "ready", name: recovered.bundle.name, digest: recovered.digest, version: 2 },
    ])
    // Flock intentionally waits for its production 60-second stale-heartbeat window after SIGKILL.
    // A second process must then recover the lock, without changing production timing or mocking the clock.
    await restarted.replaceSerialized(alternate.value.text, "factory", recovered.digest, alternate.value.digest)
    expect((await Library.local(root).preview("factory")).text).toBe(alternate.value.text)
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 85_000)

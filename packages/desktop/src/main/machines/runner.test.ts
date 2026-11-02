import { describe, expect, test } from "bun:test"
import {
  createExecFileExecutor,
  detectContainerRuntime,
  execInContainer,
  isContainerRunning,
  removeContainer,
  startContainer,
  stopContainer,
  type Executor,
} from "./runner"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "container",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

function fakeExec(seen: string[][], stdout = "", exitCode = 0): Executor {
  return async (command) => {
    seen.push([...command])

    return { stdout, exitCode }
  }
}

describe("container machine runner", () => {
  test("start, stop, remove and exec forward the exact driver commands", async () => {
    const seen: string[][] = []
    const exec = fakeExec(seen)

    await startContainer(exec, "docker", machine)
    await stopContainer(exec, "docker", machine)
    await removeContainer(exec, "docker", machine)
    await execInContainer(exec, "docker", machine, ["bun", "--version"])

    expect(seen[0][1]).toBe("run")
    expect(seen[1]).toEqual(["docker", "stop", "orchestra-machine-m1"])
    expect(seen[2]).toEqual(["docker", "rm", "orchestra-machine-m1"])
    expect(seen[3]).toEqual(["docker", "exec", "orchestra-machine-m1", "bun", "--version"])
  })

  test("status parses docker inspect output, and failures throw instead of lying", async () => {
    expect(await isContainerRunning(fakeExec([], "true\n"), "docker", machine)).toBe(true)
    expect(await isContainerRunning(fakeExec([], "false\n"), "docker", machine)).toBe(false)
    await expect(startContainer(fakeExec([], "", 1), "docker", machine)).rejects.toThrow("Command failed (1)")
  })

  test("real execFile executor runs a plain command and reports a failing one", async () => {
    const exec = createExecFileExecutor()

    expect((await exec(["echo", "hello"])).stdout.trim()).toBe("hello")
    expect((await exec(["false"])).exitCode).not.toBe(0)
  })

  test("runtime detection prefers docker and refuses when neither is found", async () => {
    const dockerOnly: Executor = async (command) => ({ stdout: "", exitCode: command[1] === "docker" ? 0 : 1 })

    expect(await detectContainerRuntime(dockerOnly)).toBe("docker")
    await expect(detectContainerRuntime(fakeExec([], "", 1))).rejects.toThrow("No container runtime available")
  })
})

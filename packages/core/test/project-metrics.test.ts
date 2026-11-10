import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, mkdir, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectMetrics as M } from "../src/project-files/metrics"
const receipt = (): M.Receipt => ({
  projectID: "prj_a",
  sessionID: "ses_a",
  messageID: "msg_a",
  providerID: "provider",
  modelID: "model/v1",
  at: 100,
  tokens: { input: 10, output: 20, reasoning: 3, cacheRead: null, cacheWrite: 0 },
})
test("metrics scalar projection never includes supplied prose, page data or raw request fields", () => {
  const encoded = M.encode({
    ...receipt(),
    prompt: "PRIVATE_PROMPT",
    pageText: "PRIVATE_PAGE",
    headers: { authorization: "sk-private-123456789" },
  } as M.Receipt)
  for (const value of ["PRIVATE", "prompt", "headers", "pageText", "sk-private"]) expect(encoded).not.toContain(value)
  expect(JSON.parse(encoded)).toMatchObject({ type: "primary-usage", tokens: { input: 10, cacheRead: null } })
  for (const bad of [
    { ...receipt(), modelID: "sk-proj-private-key-12345678" },
    { ...receipt(), tokens: { ...receipt().tokens, input: NaN } },
    { ...receipt(), projectID: "private title" },
  ])
    expect(() => M.encode(bad)).toThrow()
})
test("project receipts survive reopen and stay out of a different project", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "metrics-a-")),
    b = await mkdtemp(path.join(os.tmpdir(), "metrics-b-"))
  try {
    await M.append(a, receipt())
    await M.append(a, { ...receipt(), messageID: "msg_b" })
    const rows = (await readFile(path.join(a, ".orchestra", "metrics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.messageID)).toEqual(["msg_a", "msg_b"])
    await expect(readFile(path.join(b, ".orchestra", "metrics.jsonl"))).rejects.toThrow()
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})
test("linked output folders cannot redirect project metrics", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "metrics-link-")),
    b = await mkdtemp(path.join(os.tmpdir(), "metrics-out-"))
  try {
    await symlink(b, path.join(a, ".orchestra"), process.platform === "win32" ? "junction" : "dir")
    await expect(M.append(a, receipt())).rejects.toThrow("real project directory")
    await expect(readFile(path.join(b, "metrics.jsonl"))).rejects.toThrow()
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test("actual runner capture writes the primary scalar receipt; unavailable sink never fails a request", async () => {
  const { SessionRunnerLLM } = await import("../src/session/runner/llm")
  const { Effect } = await import("effect")
  const dir = await mkdtemp(path.join(os.tmpdir(), "metrics-runner-"))
  const { tokens, at, ...ids } = receipt()
  try {
    await Effect.runPromise(SessionRunnerLLM.usageCapture(dir, ids)(tokens))
    const row = JSON.parse(await readFile(path.join(dir, ".orchestra", "metrics.jsonl"), "utf8"))
    expect(row).toMatchObject({ ...ids, tokens, type: "primary-usage" })
    await Effect.runPromise(SessionRunnerLLM.usageCapture(path.join(dir, "missing"), ids)(tokens))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("metrics append is bounded and linked files cannot redirect it", async () => {
  const { truncate, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(path.join(os.tmpdir(), "metrics-bounds-"))
  try {
    await mkdir(path.join(dir, ".orchestra"))
    const target = path.join(dir, ".orchestra", "metrics.jsonl")
    await writeFile(target, "")
    await truncate(target, M.MAX_BYTES)
    await expect(M.append(dir, receipt())).rejects.toThrow("limit")
    await rm(target)
    await symlink(path.join(dir, "outside"), target, process.platform === "win32" ? "file" : "file")
    await expect(M.append(dir, receipt())).rejects.toThrow("regular file")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

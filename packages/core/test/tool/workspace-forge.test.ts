import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { WorkspaceForgeTool } from "@orchestra/core/tool/plugin/workspace-forge"
import { Orchestra } from "@orchestra/schema/orchestra"

const decode = Schema.decodeUnknownSync(WorkspaceForgeTool.Input)

describe("workspace forge input", () => {
  test("Group Orchestrators can coordinate only through approval-checked federation", () => {
    expect(Orchestra.groupSupervisorPermissions()).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "federation", resource: "*", effect: "ask" },
      // The chat may ask its own operator a question; everything else still goes through federation approval.
      { action: "question", resource: "*", effect: "allow" },
    ])
  })

  test("accepts sandbox modes and an individual AI role for workspace creation", () => {
    for (const sandbox of ["none", "environment", "strict"] as const) {
      expect(
        decode({
          action: "create_session",
          directory: "/work/project",
          sandbox,
          role: "backend",
        }),
      ).toMatchObject({ action: "create_session", directory: "/work/project", sandbox, role: "backend" })
    }
  })

  test("accepts group members that mix existing projects with newly configured workspaces", () => {
    expect(
      decode({
        action: "create_group",
        name: "mobile-platform",
        mode: "council",
        members: [
          { projectID: "prj_existing" },
          { name: "Android app", directory: "/work/android", team: "mobile-app", sandbox: "strict" },
          { name: "API", directory: "/work/api", role: "backend", sandbox: "none" },
        ],
        link: false,
      }),
    ).toMatchObject({
      action: "create_group",
      name: "mobile-platform",
      mode: "council",
      members: [
        { projectID: "prj_existing" },
        { name: "Android app", directory: "/work/android", team: "mobile-app", sandbox: "strict" },
        { name: "API", directory: "/work/api", role: "backend", sandbox: "none" },
      ],
      link: false,
    })
  })

  test("rejects unsupported actions and sandbox modes", () => {
    expect(() => decode({ action: "delete_all" })).toThrow()
    expect(() => decode({ action: "create_session", directory: "/work/project", sandbox: "unconfined" })).toThrow()
  })

  test("requires at least two members to create a federated group", () => {
    expect(WorkspaceForgeTool.groupMemberCountError(undefined)).toContain("at least two members")
    expect(WorkspaceForgeTool.groupMemberCountError([{ projectID: "prj_existing" }])).toContain("at least two members")
    expect(
      WorkspaceForgeTool.groupMemberCountError([
        { projectID: "prj_existing" },
        { directory: "/work/new-project" },
      ]),
    ).toBeUndefined()
  })

  test("requires the operator's coordination mode before creating a group", () => {
    expect(WorkspaceForgeTool.groupModeError(undefined)).toContain("needs mode")
    expect(WorkspaceForgeTool.groupModeError("lead")).toBeUndefined()
    expect(WorkspaceForgeTool.groupModeError("council")).toBeUndefined()
  })
})

describe("workspace forge directories", () => {
  test("resolves a relative member path against the Orchestrator's project, not the service", () => {
    const base = path.resolve("/work/game")
    expect(WorkspaceForgeTool.resolveDirectory(base, "translations")).toBe(path.join(base, "translations"))
    expect(WorkspaceForgeTool.resolveDirectory(base, "../engine")).toBe(path.resolve("/work/engine"))
    expect(WorkspaceForgeTool.resolveDirectory(base, path.resolve("/other/place"))).toBe(path.resolve("/other/place"))
    expect(WorkspaceForgeTool.resolveDirectory(base, "~/game", path.resolve("/home/me"))).toBe(path.resolve("/home/me/game"))
  })

  test("treats a directory with only tool metadata as empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-empty-"))
    expect(await WorkspaceForgeTool.isEmptyDirectory(root)).toBe(true)
    await mkdir(path.join(root, ".git"))
    expect(await WorkspaceForgeTool.isEmptyDirectory(root)).toBe(true)
    await writeFile(path.join(root, "game.json"), "{}")
    expect(await WorkspaceForgeTool.isEmptyDirectory(root)).toBe(false)
  })
})

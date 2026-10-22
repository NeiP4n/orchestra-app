import { expect, test } from "bun:test"
import { Location as CoreLocation } from "@orchestra/core/location"
import { SessionInbox as CoreSessionInbox } from "@orchestra/core/session/inbox"
import { SessionMessage as CoreSessionMessage } from "@orchestra/core/session/message"
import { Agent } from "@orchestra/schema/agent"
import { Config } from "@orchestra/schema/config"
import { Event } from "@orchestra/schema/event"
import { Location } from "@orchestra/schema/location"
import { Model } from "@orchestra/schema/model"
import { Project } from "@orchestra/schema/project"
import { Provider } from "@orchestra/schema/provider"
import { WebSearch } from "@orchestra/schema/websearch"
import { Session } from "@orchestra/schema/session"
import { SessionInbox } from "@orchestra/schema/session-inbox"
import { SessionMessage } from "@orchestra/schema/session-message"
import { Workspace } from "@orchestra/schema/workspace"
import { Worktree } from "@orchestra/schema/worktree"
import { Api } from "@orchestra/server/api"
import { ClientApi, groupNames, promiseOmitEndpoints } from "@orchestra/protocol/client"
import { compile, emitPromise } from "@orchestra/httpapi-codegen"

const SDK = await import("../src/index")
const CoreAgent = await import("@orchestra/core/agent")
const CoreModel = await import("@orchestra/core/model")
const CoreProject = await import("@orchestra/core/project")
const CoreSession = await import("@orchestra/core/session")
const CoreWorktree = await import("@orchestra/core/worktree")

test("re-exports canonical contracts directly from Schema", () => {
  expect(SDK.Agent).toBe(Agent)
  expect(SDK.Config).toBe(Config)
  expect(SDK.Event).toBe(Event)
  expect(SDK.Model).toBe(Model)
  expect(SDK.WebSearch).toBe(WebSearch)
  expect(SDK.Session).toBe(Session)
  expect(SDK.Worktree).toBe(Worktree)
  expect(SDK.Workspace).toBe(Workspace)
  expect(Object.keys(SDK).sort()).toEqual([
    "AbsolutePath",
    "Agent",
    "ClientError",
    "Command",
    "Config",
    "Credential",
    "Event",
    "FileSystem",
    "Integration",
    "Location",
    "Model",
    "OpenCode",
    "Permission",
    "PermissionSaved",
    "Project",
    "Prompt",
    "PromptInput",
    "Provider",
    "Pty",
    "Question",
    "Reference",
    "RelativePath",
    "Session",
    "SessionInbox",
    "SessionMessage",
    "Skill",
    "Tool",
    "WebSearch",
    "Workspace",
    "Worktree",
  ])
})

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(CoreAgent.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(CoreModel.Ref).toBe(Model.Ref)
  expect(CoreSession.Info).toBe(Session.Info)
  expect(CoreProject.Current).toBe(Project.Current)
  expect(CoreWorktree.DirectoryUnavailableError).toBeDefined()
  expect(CoreWorktree.List).toBe(Worktree.List)
  expect(CoreWorktree.Info).toBe(Worktree.Info)
  expect(CoreSessionInbox.Item).toBe(SessionInbox.Item)
  expect(CoreSessionInbox.User).toBe(SessionInbox.User)
  expect(CoreSessionInbox.Synthetic).toBe(SessionInbox.Synthetic)
  expect(CoreSessionMessage.Info).toBe(SessionMessage.Info)
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(Api.groups["server.project"].identifier).toBe("server.project")
  expect(Object.keys(ClientApi.groups)).toEqual(Object.keys(Api.groups))
  expect(Session.ID.create()).toStartWith("ses_")
  expect(String(Project.ID.global)).toBe("global")
  expect(String(Provider.ID.anthropic)).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server contracts generate identically", () => {
  const server = compile(Api, { groupNames, omitEndpoints: promiseOmitEndpoints })
  const client = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })

  expect(emitPromise(client)).toEqual(emitPromise(server))
})

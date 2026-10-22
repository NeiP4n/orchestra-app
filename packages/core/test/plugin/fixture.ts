import { Agent } from "@orchestra/core/agent"
import { AISDK } from "@orchestra/core/aisdk"
import { Command } from "@orchestra/core/command"
import { Config } from "@orchestra/core/config"
import { Credential } from "@orchestra/core/credential"
import { LayerNodePlatform } from "@orchestra/util/effect/app-node-platform"
import { AppProcess } from "@orchestra/util/process"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { FileSystem } from "@orchestra/core/filesystem"
import { FSUtil } from "@orchestra/util/fs-util"
import { Form } from "@orchestra/core/form"
import { Generate } from "@orchestra/core/generate"
import { Integration } from "@orchestra/core/integration"
import { KV } from "@orchestra/core/kv"
import { Location } from "@orchestra/core/location"
import { ManagedPolicy } from "@orchestra/core/managed-policy"
import { Mcp } from "@orchestra/core/mcp/index"
import { Model } from "@orchestra/core/model"
import { Npm } from "@orchestra/util/npm"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { Provider } from "@orchestra/core/provider"
import { Session } from "@orchestra/core/session"
import { PersistentPty } from "@orchestra/core/persistent-pty"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Permission } from "@orchestra/core/permission"
import { Reference } from "@orchestra/core/reference"
import { Rpc } from "@orchestra/core/rpc"
import { Skill } from "@orchestra/core/skill"
import { SkillDiscovery } from "@orchestra/core/skill/discovery"
import { Watcher } from "@orchestra/core/filesystem/watcher"
import { Tool } from "@orchestra/core/tool"
import { Vcs } from "@orchestra/core/vcs"
import { WebSearch } from "@orchestra/core/websearch"
import { Worktree } from "@orchestra/core/worktree"
import { WorktreeStrategies } from "@orchestra/core/worktree/strategies"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const configLayer = Config.testLayer()

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    confirm: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    Config.node,
    Bus.node,
    Form.node,
    Generate.node,
    LayerNodePlatform.httpClient,
    Plugin.node,
    Agent.node,
    AISDK.node,
    Provider.node,
    Model.node,
    Command.node,
    Integration.node,
    KV.node,
    ManagedPolicy.node,
    Mcp.node,
    Session.node,
    PersistentPty.node,
    LocationServiceMap.node,
    Permission.node,
    PluginHooks.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    SkillDiscovery.node,
    Tool.node,
    Vcs.node,
    Watcher.node,
    WebSearch.node,
    Worktree.node,
    WorktreeStrategies.node,
  ]),
  [
    Location.node.replace(tempLocationLayer),
    Npm.node.replace(npmLayer),
    Config.node.replace(configLayer),
    Mcp.node.replace(emptyMcpLayer),
    Generate.node.replace(generateLayer),
    Permission.node.replace(permissionLayer),
  ],
).pipe(Layer.provideMerge(configLayer))

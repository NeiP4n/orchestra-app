import { Database } from "@orchestra/core/database/database"
import { V1Migration } from "@orchestra/core/database/v1-migration"
import { App } from "@orchestra/core/app"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Node } from "@orchestra/util/effect/app-node"
import { httpClient } from "@orchestra/util/effect/app-node-platform"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Bus } from "@orchestra/core/bus"
import { EventLogger } from "@orchestra/core/event-logger"
import { FileSystemSearch } from "@orchestra/core/filesystem/search"
import { Credential } from "@orchestra/core/credential"
import { Config } from "@orchestra/core/config"
import { PermissionSaved } from "@orchestra/core/permission/saved"
import { PtyTicket } from "@orchestra/core/pty/ticket"
import { PersistentPty } from "@orchestra/core/persistent-pty"
import { Project } from "@orchestra/core/project"
import { Worktree } from "@orchestra/core/worktree"
import { Session } from "@orchestra/core/session"
import { Instance } from "@orchestra/core/instance/service"
import { SessionTransfer } from "@orchestra/core/session/transfer"
import { ShellSelect } from "@orchestra/core/shell/select"
import { Job } from "@orchestra/core/job"
import { Mcp } from "@orchestra/core/mcp/index"
import { Global } from "@orchestra/util/global"
import { InstructionDiscovery } from "@orchestra/core/instruction-discovery"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { LocationActivity } from "@orchestra/core/location-activity"
import { ModelsDev } from "@orchestra/core/models-dev"
import { SessionRestart } from "@orchestra/core/session/execution/restart"
import { PluginUpdate } from "@orchestra/core/plugin/update"
import { SdkPlugins } from "@orchestra/core/plugin/sdk"
import { WellKnown } from "@orchestra/core/wellknown"
import { Workspace } from "@orchestra/core/workspace"
import { Room } from "@orchestra/core/room"
import { Federation } from "@orchestra/core/federation"
import { Orchestra } from "@orchestra/core/orchestra"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { Peer } from "@orchestra/core/peer"
import { Plot } from "@orchestra/core/plot"
import { Watcher } from "@orchestra/core/filesystem/watcher"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Context, Effect, Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { CorsConfig } from "./cors"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { ServerPairing } from "./pairing"
import { ServerRooms } from "./rooms"
import { ServerMesh } from "./mesh"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
import { ServerInfo } from "./server-info"
import type { ServerOptions } from "./options"
import { legacyRouteAlias } from "./alias"

const applicationServiceNodes = [
  Global.node,
  Database.node,
  Bus.node,
  EventLogger.node,
  httpClient,
  Job.node,
  Project.node,
  Worktree.node,
  Session.node,
  Instance.node,
  SessionTransfer.node,
  SdkPlugins.node,
  PluginUpdate.node,
  PermissionSaved.node,
  PtyTicket.node,
  PersistentPty.node,
  Credential.node,
  WellKnown.node,
  PtyEnvironment.node,
  ServerPairing.node,
  ServerRooms.node,
  ServerMesh.node,
  Room.node,
  Federation.node,
  Orchestra.node,
  Autoloop.node,
  Peer.node,
  Plot.node,
  LocationServiceMap.node,
  LocationActivity.node,
  SessionRestart.node,
  Workspace.node,
] as const
const applicationServices = LayerNode.group(applicationServiceNodes)

export function createRoutes(
  options: ServerOptions = {},
  serviceURLs: () => ReadonlyArray<string> = () => [],
  overrides: LayerNode.Replacements = [],
) {
  return makeRoutes(
    options.password
      ? ServerAuth.Config.configLayer({
          password: Option.some(options.password),
          sessionTtlSeconds: options.sessionTtlSeconds,
        })
      : ServerAuth.Config.layer,
    options,
    serviceURLs,
    overrides,
  )
}

type InstanceNode = (
  replacements: () => LayerNode.Replacements,
) => LayerNode.Provider<Instance.Service, never, typeof Node.tags.values.global>

export function createEmbeddedRoutes(
  options: ServerOptions = {},
  overrides: LayerNode.Replacements = [],
  instances?: InstanceNode,
) {
  return makeRoutes(ServerAuth.Config.configLayer({ password: Option.none() }), options, () => [], overrides, instances)
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options: ServerOptions,
  serviceURLs: () => ReadonlyArray<string>,
  // Runtime-profile replacements (e.g. workerd) applied after the standard set, so later entries win.
  overrides: LayerNode.Replacements,
  instances?: InstanceNode,
) {
  const standard: LayerNode.Replacements = [
    Database.node.replace(Database.configured(options.database)),
    PersistentPty.node.replace(PersistentPty.configured(options.pty)),
    Bus.node.replace(Bus.configured({ persist: options.events?.persist })),
    App.node.replace(App.configured(options.app)),
    ModelsDev.node.replace(ModelsDev.configured(options.models)),
    Watcher.node.replace(Watcher.configured({ enabled: options.fs?.filewatcher })),
    FileSystemSearch.node.replace(FileSystemSearch.configured({ fff: options.fs?.fff })),
    Global.node.replace(Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})),
    Config.node.replace(
      Config.configured({
        project: options.config?.project,
        file: options.config?.file,
        content: options.config?.content,
      }),
    ),
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: options.config?.project })),
    ShellSelect.node.replace(ShellSelect.configured({ gitbash: options.windows?.gitbash })),
    Mcp.node.replace(
      Mcp.configured({
        clientInfo: {
          name: "opencode",
          version: options.app?.version ?? "unknown",
        },
      }),
    ),
  ]
  const build = (overrides: LayerNode.Replacements) => {
    const replacements: LayerNode.Replacements = [
      ...standard,
      // Private instances resolve this list lazily so they inherit the complete host graph, including the selector.
      ...(instances ? [Instance.node.replace(instances(() => replacements))] : []),
      ...overrides,
    ]
    return AppNodeBuilder.build(applicationServices, replacements)
  }
  const serviceLayer = options.simulation
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements } = yield* Effect.promise(() => import("@orchestra/simulation/backend"))
          const simulation = yield* simulationReplacements({ version: App.make(options.app).version })
          return build([...overrides, ...simulation])
        }),
      )
    : build(overrides)
  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      const services = Layer.succeedContext(context)
      const requestServices = Layer.merge(
        Layer.succeedContext(
          Context.pick(
            Database.Service,
            Credential.Service,
            PermissionSaved.Service,
            PluginUpdate.Service,
            Project.Service,
            WellKnown.Service,
          )(context),
        ),
        ServerInfo.layer(serviceURLs, Context.get(context, Global.Service).tmp, options.app),
      )
      const aliasedHttpRouterLayer = Layer.effect(
        HttpRouter.HttpRouter,
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter
          return {
            ...router,
            asHttpEffect() {
              return legacyRouteAlias(router.asHttpEffect())
            },
          }
        }),
      ).pipe(Layer.provide(HttpRouter.layer))
      const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers.pipe(Layer.provide(services), Layer.provide(Layer.succeed(CorsConfig, options)))),
        Layer.provide(formLocationLayer),
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(services),
        Layer.provideMerge(aliasedHttpRouterLayer),
      )
      return Layer.merge(api, V1Migration.layer.pipe(Layer.provide(services)))
    }),
  )
}

// Temporary diagnostics: every element with a non-never node error channel errors here;
// the element order matches applicationServiceNodes above, so the line marks the node.
export const diagNodeErrors: readonly never[] = [
  0 as unknown as typeof Global.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Database.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Bus.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof EventLogger.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof httpClient extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Job.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Project.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Worktree.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Session.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Instance.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof SessionTransfer.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof SdkPlugins.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof PluginUpdate.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof PermissionSaved.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof PtyTicket.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof PersistentPty.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Credential.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof WellKnown.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof PtyEnvironment.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof ServerPairing.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof ServerRooms.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof ServerMesh.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Room.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Federation.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Orchestra.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Autoloop.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Peer.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Plot.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof LocationServiceMap.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof LocationActivity.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof SessionRestart.node extends LayerNode.Graph<never, infer E> ? E : never,
  0 as unknown as typeof Workspace.node extends LayerNode.Graph<never, infer E> ? E : never,
]

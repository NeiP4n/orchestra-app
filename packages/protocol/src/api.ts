import { Context, Schema } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { Mcp } from "@orchestra/schema/mcp"
import { SchemaErrorMiddleware } from "./middleware/schema-error.js"
import { GenerateGroup } from "./groups/generate.js"
import { MessageGroup } from "./groups/message.js"
import { ModelGroup } from "./groups/model.js"
import { ProviderGroup } from "./groups/provider.js"
import { makeSessionGroup } from "./groups/session.js"
import { makePermissionGroup } from "./groups/permission.js"
import { FileSystemGroup } from "./groups/fs.js"
import { makeFormGroup } from "./groups/form.js"
import { CommandGroup } from "./groups/command.js"
import { SkillGroup } from "./groups/skill.js"
import { RpcGroup } from "./groups/rpc.js"
import { EventGroup, makeEventGroup } from "./groups/event.js"
import type { Definition } from "@orchestra/schema/event"
import { AgentGroup } from "./groups/agent.js"
import { PluginGroup } from "./groups/plugin.js"
import { ServerGroup } from "./groups/server.js"
import { DebugGroup } from "./groups/debug.js"
import { makePtyGroup } from "./groups/pty.js"
import { PersistentPtyGroup } from "./groups/persistent-pty.js"
import { ShellGroup } from "./groups/shell.js"
import { ReferenceGroup } from "./groups/reference.js"
import { Authorization } from "./middleware/authorization.js"
import { makeLocationGroup } from "./groups/location.js"
import { IntegrationGroup } from "./groups/integration.js"
import { WebSearchGroup } from "./groups/websearch.js"
import { McpGroup } from "./groups/mcp.js"
import { CredentialGroup } from "./groups/credential.js"
import { ProjectGroup } from "./groups/project.js"
import { WorktreeGroup } from "./groups/worktree.js"
import { VcsGroup } from "./groups/vcs.js"
import { NoteGroup } from "./groups/note.js"
import { MigrationGroup } from "./groups/migration.js"
import { ConfigGroup } from "./groups/config.js"
import { RoomGroup } from "./groups/room.js"
import { OrchestraGroup } from "./groups/orchestra.js"
import { QuotaGroup } from "./quota.js"

type LocationGroups<LocationId extends HttpApiMiddleware.AnyId> =
  | HttpApiGroup.AddMiddleware<typeof AgentGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof PluginGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ModelGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProviderGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof IntegrationGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof WebSearchGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof McpGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProjectGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof FileSystemGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof CommandGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof SkillGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof RpcGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ShellGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ReferenceGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof VcsGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof NoteGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ConfigGroup, LocationId>

type PtyGroups<LocationId extends HttpApiMiddleware.AnyId, LocationService> = ReturnType<
  typeof makePtyGroup<LocationId, LocationService>
>

type SessionGroups<
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
> =
  | ReturnType<typeof makeSessionGroup<SessionLocationId, SessionLocationService, FormLocationId, FormLocationService>>
  | typeof MessageGroup

type FormGroups<LocationId extends HttpApiMiddleware.AnyId, LocationService> = ReturnType<
  typeof makeFormGroup<LocationId, LocationService>
>

type LocationGroup<LocationId extends HttpApiMiddleware.AnyId, LocationService> = ReturnType<
  typeof makeLocationGroup<LocationId, LocationService>
>

type MixedMiddlewareGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
> = ReturnType<typeof makePermissionGroup<LocationId, LocationService, SessionLocationId, SessionLocationService>>

type ApiGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> =
  | typeof ServerGroup
  | typeof DebugGroup
  | typeof MigrationGroup
  | typeof WorktreeGroup
  | typeof GenerateGroup
  | typeof PersistentPtyGroup
  | typeof CredentialGroup
  | typeof RoomGroup
  | typeof OrchestraGroup
  | typeof QuotaGroup
  | LocationGroups<LocationId>
  | LocationGroup<LocationId, LocationService>
  | PtyGroups<LocationId, LocationService>
  | FormGroups<LocationId, LocationService>
  | SessionGroups<SessionLocationId, SessionLocationService, FormLocationId, FormLocationService>
  | MixedMiddlewareGroups<LocationId, LocationService, SessionLocationId, SessionLocationService>
  | Event

type EventGroupFor<Definitions extends ReadonlyArray<Definition>> = ReturnType<typeof makeEventGroup<Definitions>>

export type Api<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> = HttpApi.HttpApi<
  "server",
  HttpApiGroup.AddMiddleware<
    HttpApiGroup.AddMiddleware<
      ApiGroups<
        LocationId,
        LocationService,
        FormLocationId,
        FormLocationService,
        SessionLocationId,
        SessionLocationService,
        Event
      >,
      Authorization
    >,
    SchemaErrorMiddleware
  >
>

// Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Constraint,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
  formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  Group
> =>
  HttpApi.make("server")
    .add(ServerGroup)
    .add(makeLocationGroup(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    .add(PluginGroup.middleware(locationMiddleware))
    .add(makeSessionGroup(sessionLocationMiddleware, formLocationMiddleware))
    .add(MessageGroup)
    .add(ModelGroup.middleware(locationMiddleware))
    .add(GenerateGroup)
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(McpGroup.middleware(locationMiddleware))
    .add(CredentialGroup)
    .add(ProjectGroup.middleware(locationMiddleware))
    .add(makeFormGroup(locationMiddleware))
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(RpcGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(makePtyGroup(locationMiddleware))
    .add(PersistentPtyGroup)
    .add(ShellGroup.middleware(locationMiddleware))
    .add(ReferenceGroup.middleware(locationMiddleware))
    .add(WorktreeGroup)
    .add(VcsGroup.middleware(locationMiddleware))
    .add(NoteGroup.middleware(locationMiddleware))
    .add(DebugGroup)
    .add(MigrationGroup)
    .add(WebSearchGroup.middleware(locationMiddleware))
    .add(ConfigGroup.middleware(locationMiddleware))
    .add(RoomGroup)
    .add(OrchestraGroup)
    .add(QuotaGroup)
    .annotateMerge(
      OpenApi.annotations({
        title: "Orchestra HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

export const makeApi = <
  const Definitions extends ReadonlyArray<Definition>,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly definitions: Definitions
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  EventGroupFor<Definitions>
> =>
  makeApiFromGroup(
    makeEventGroup(options.definitions),
    options.locationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )

export const makeDefaultApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  typeof EventGroup
> =>
  makeApiFromGroup(
    EventGroup,
    options.locationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )

export class InvalidStreamableHttpEndpointError extends Schema.TaggedError<InvalidStreamableHttpEndpointError>()(
  "InvalidStreamableHttpEndpointError",
  {
    message: Schema.String,
    url: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export interface StreamableHttpEndpointValidation {
  readonly valid: boolean
  readonly url?: string
  readonly error?: string
}

export function validateStreamableHttpEndpoint(
  config: Mcp.StreamableHttpConfig | { readonly url: string; readonly heartbeatInterval?: number; readonly streamTimeout?: number } | unknown,
): StreamableHttpEndpointValidation {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "Streamable HTTP config must be an object" }
  }
  const candidate = config as Record<string, unknown>
  if (candidate.type !== "streamable-http" && candidate.type !== undefined) {
    return { valid: false, error: `Invalid transport type: expected streamable-http, got ${String(candidate.type)}` }
  }
  if (typeof candidate.url !== "string" || candidate.url.trim().length === 0) {
    return { valid: false, error: "Streamable HTTP endpoint URL is required and must not be empty" }
  }
  const url = candidate.url.trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, url, error: `Invalid URL protocol: ${parsed.protocol} (must be http: or https:)` }
    }
  } catch {
    return { valid: false, url, error: `Invalid URL format: ${url}` }
  }

  if (candidate.heartbeatInterval !== undefined) {
    if (
      typeof candidate.heartbeatInterval !== "number" ||
      !Number.isFinite(candidate.heartbeatInterval) ||
      candidate.heartbeatInterval <= 0
    ) {
      return { valid: false, url, error: "heartbeatInterval must be a positive number in milliseconds" }
    }
  }

  if (candidate.streamTimeout !== undefined) {
    if (
      typeof candidate.streamTimeout !== "number" ||
      !Number.isFinite(candidate.streamTimeout) ||
      candidate.streamTimeout <= 0
    ) {
      return { valid: false, url, error: "streamTimeout must be a positive number in milliseconds" }
    }
  }

  if (
    typeof candidate.heartbeatInterval === "number" &&
    typeof candidate.streamTimeout === "number" &&
    candidate.heartbeatInterval >= candidate.streamTimeout
  ) {
    return {
      valid: false,
      url,
      error: `heartbeatInterval (${candidate.heartbeatInterval}ms) must be strictly less than streamTimeout (${candidate.streamTimeout}ms)`,
    }
  }

  return { valid: true, url }
}


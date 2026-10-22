import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitEffectShape, emitPromise, write } from "@orchestra/httpapi-codegen"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "@orchestra/protocol/client"
import { Agent } from "@orchestra/schema/agent"
import { Command } from "@orchestra/schema/command"
import { Config } from "@orchestra/schema/config"
import { Credential } from "@orchestra/schema/credential"
import { Room } from "@orchestra/schema/room"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Event } from "@orchestra/schema/event"
import { EventLog } from "@orchestra/schema/event-log"
import { FileDiff } from "@orchestra/schema/file-diff"
import { FileSystem } from "@orchestra/schema/filesystem"
import { Form } from "@orchestra/schema/form"
import { InstructionEntry } from "@orchestra/schema/instruction-entry"
import { Integration } from "@orchestra/schema/integration"
import { Location } from "@orchestra/schema/location"
import { Mcp } from "@orchestra/schema/mcp"
import { Model } from "@orchestra/schema/model"
import { Note } from "@orchestra/schema/note"
import { Permission } from "@orchestra/schema/permission"
import { PermissionSaved } from "@orchestra/schema/permission-saved"
import { Plugin } from "@orchestra/schema/plugin"
import { Project } from "@orchestra/schema/project"
import { Worktree } from "@orchestra/schema/worktree"
import { AgentAttachment, FileAttachment, Prompt, PromptMention } from "@orchestra/schema/prompt"
import { PromptInput } from "@orchestra/schema/prompt-input"
import { Provider } from "@orchestra/schema/provider"
import { Pty } from "@orchestra/schema/pty"
import { PtyTicket } from "@orchestra/schema/pty-ticket"
import { Question } from "@orchestra/schema/question"
import { Reference } from "@orchestra/schema/reference"
import { AbsolutePath, PositiveInt, RelativePath } from "@orchestra/schema/schema"
import { Session } from "@orchestra/schema/session"
import { SessionMessage } from "@orchestra/schema/session-message"
import { SessionInbox } from "@orchestra/schema/session-inbox"
import { Shell } from "@orchestra/schema/shell"
import { Skill } from "@orchestra/schema/skill"
import { Vcs } from "@orchestra/schema/vcs"
import { WebSearch } from "@orchestra/schema/websearch"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"

const promiseContract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })
const effectContract = compile(ClientApi, { groupNames, omitEndpoints: effectOmitEndpoints })
const effectTypeReferences = [
  ...namespaceTypes("Agent", "@orchestra/schema/agent", Agent),
  ...namespaceTypes("Command", "@orchestra/schema/command", Command),
  ...namespaceTypes("Config", "@orchestra/schema/config", Config),
  ...namespaceTypes("Credential", "@orchestra/schema/credential", Credential),
  ...namespaceTypes("Event", "@orchestra/schema/event", Event),
  ...namespaceTypes("EventLog", "@orchestra/schema/event-log", EventLog),
  ...namespaceTypes("FileDiff", "@orchestra/schema/file-diff", FileDiff),
  ...namespaceTypes("FileSystem", "@orchestra/schema/filesystem", FileSystem),
  ...namespaceTypes("Form", "@orchestra/schema/form", Form),
  ...namespaceTypes("InstructionEntry", "@orchestra/schema/instruction-entry", InstructionEntry),
  ...namespaceTypes("Integration", "@orchestra/schema/integration", Integration),
  typeReference("Location.PublicRef", "@orchestra/schema/location", Location.PublicRef),
  typeReference("Location.PublicInfo", "@orchestra/schema/location", Location.PublicInfo),
  ...namespaceTypes("Mcp", "@orchestra/schema/mcp", Mcp),
  ...namespaceTypes("Model", "@orchestra/schema/model", Model),
  ...namespaceTypes("Note", "@orchestra/schema/note", Note),
  ...namespaceTypes("Permission", "@orchestra/schema/permission", Permission),
  ...namespaceTypes("PermissionSaved", "@orchestra/schema/permission-saved", PermissionSaved),
  ...namespaceTypes("Plugin", "@orchestra/schema/plugin", Plugin),
  ...namespaceTypes("Project", "@orchestra/schema/project", Project),
  ...namespaceTypes("Worktree", "@orchestra/schema/worktree", Worktree),
  ...namespaceTypes("PromptInput", "@orchestra/schema/prompt-input", PromptInput),
  ...namespaceTypes("Provider", "@orchestra/schema/provider", Provider),
  ...namespaceTypes("Pty", "@orchestra/schema/pty", Pty),
  ...namespaceTypes("PtyTicket", "@orchestra/schema/pty-ticket", PtyTicket),
  ...namespaceTypes("Question", "@orchestra/schema/question", Question),
  ...namespaceTypes("Reference", "@orchestra/schema/reference", Reference),
  ...namespaceTypes("Room", "@orchestra/schema/room", Room),
  ...namespaceTypes("Orchestra", "@orchestra/schema/orchestra", Orchestra),
  ...namespaceTypes("Session", "@orchestra/schema/session", Session),
  ...namespaceTypes("SessionMessage", "@orchestra/schema/session-message", SessionMessage),
  ...namespaceTypes("SessionInbox", "@orchestra/schema/session-inbox", SessionInbox),
  ...namespaceTypes("Shell", "@orchestra/schema/shell", Shell),
  ...namespaceTypes("Skill", "@orchestra/schema/skill", Skill),
  ...namespaceTypes("Vcs", "@orchestra/schema/vcs", Vcs),
  ...namespaceTypes("WebSearch", "@orchestra/schema/websearch", WebSearch),
  typeReference("Prompt", "@orchestra/schema/prompt", Prompt),
  typeReference("PromptMention", "@orchestra/schema/prompt", PromptMention),
  typeReference("FileAttachment", "@orchestra/schema/prompt", FileAttachment),
  typeReference("AgentAttachment", "@orchestra/schema/prompt", AgentAttachment),
  typeReference("AbsolutePath", "@orchestra/schema/schema", AbsolutePath),
  typeReference("PositiveInt", "@orchestra/schema/schema", PositiveInt),
  typeReference("RelativePath", "@orchestra/schema/schema", RelativePath),
]

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(promiseContract, {
          mutableOutputs: true,
        }),
        fileURLToPath(new URL("../src/promise/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(effectContract, {
          module: "../../contract",
          api: "ClientApi",
          shapeModule: "../api/api.js",
        }),
        fileURLToPath(new URL("../src/effect/generated", import.meta.url)),
      ),
      write(
        emitEffectShape(effectContract, {
          typeReferences: effectTypeReferences,
          outputTypes: {
            "event.subscribe": {
              name: "OpenCodeEvent",
              import: 'import type { OpenCodeEvent } from "@orchestra/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/effect/api", import.meta.url)),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)

function namespaceTypes(namespace: string, module: string, values: object) {
  return Object.entries(values).flatMap(([name, schema]) =>
    Schema.isSchema(schema) ? [typeReference(`${namespace}.${name}`, module, schema)] : [],
  )
}

function typeReference(name: string, module: string, schema: Schema.Top) {
  return {
    schema,
    name,
    import: `import type { ${name.split(".")[0]} } from ${JSON.stringify(module)}`,
  }
}

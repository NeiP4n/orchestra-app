export * as McpForgeTool from "./mcp-forge.js"

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Mcp } from "@orchestra/schema/mcp"
import { Path } from "@orchestra/util/global"
import { Effect, Option, Schema } from "effect"
import { Config } from "../../config.js"
import { McpForge } from "../../mcp/forge.js"

export const name = "mcp_forge"
export const command = "forge-mcp"

const description = [
  "Build and register an MCP server. Actions: list shows the registered servers; preview validates a description and shows where the module would go; save writes the module and registers it in the global config.",
  "Sources: tools (you design the tools), openapi (one tool per operation), cli (one tool per subcommand), server (register an existing local command or remote URL as it is).",
  "The generated server is one self-contained .mjs module that speaks MCP over stdio and needs only Node 18+ or Bun. Secrets never go in the module: a header value uses ${ENV_NAME} from the server's environment.",
  "Always preview before save, fix every problem, and never overwrite an existing module or server unless the operator explicitly asked for that exact change.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "preview", "save"]),
  source: Schema.optionalKey(Schema.Literals(["tools", "openapi", "cli", "server"])).annotate({
    description: "Where the server comes from; inferred from the field you provide when omitted",
  }),
  name: Schema.optionalKey(Schema.String).annotate({
    description: "Server name: lowercase letters, digits, - or _, starting with a letter. Its tools appear as <name>_<tool>",
  }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "For source tools: what the server is for" }),
  tools: Schema.optionalKey(Schema.Array(McpForge.ToolSpec)).annotate({
    description: "For source tools: the tools you designed",
  }),
  openapi: Schema.optionalKey(Schema.Unknown).annotate({
    description: "For source openapi: the OpenAPI 3 or Swagger 2 document, as an object or JSON text",
  }),
  baseUrl: Schema.optionalKey(Schema.String).annotate({
    description: "For source openapi: absolute base URL when the document has no usable server URL",
  }),
  methods: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "For source openapi: HTTP methods to include, e.g. [GET, POST]; defaults to all of them",
  }),
  limit: Schema.optionalKey(Schema.Number).annotate({
    description: "For source openapi: maximum number of tools, default 80",
  }),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "For source openapi: headers sent with every request; values may use ${ENV_NAME}",
  }),
  cli: Schema.optionalKey(McpForge.Cli).annotate({ description: "For source cli: the program and its subcommands" }),
  server: Schema.optionalKey(Mcp.ServerConfig).annotate({
    description: "For source server: the existing server config to register as it is",
  }),
  path: Schema.optionalKey(Schema.String).annotate({
    description: "For save: module path; defaults to <config>/mcp/<name>.mjs",
  }),
  overwrite: Schema.optionalKey(Schema.Boolean).annotate({
    description: "For save: replace an existing module or registered server of the same name",
  }),
})

export const Output = Schema.Struct({ output: Schema.String })

export const Plugin = {
  id: "orchestra.tool.mcp-forge",
  effect: Effect.fn("McpForgeTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service

    const registered = Effect.fnUntraced(function* () {
      return Config.latest(yield* config.entries(), "mcp")?.servers ?? {}
    })

    const register = Effect.fnUntraced(function* (name: string, server: Mcp.ServerConfig) {
      const update = config.update
      if (!update)
        return yield* new ToolFailure({
          message: "This runtime cannot write the global config, so the server was not registered.",
        })
      yield* update({ mcpServers: { [name]: server } }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              if (input.action === "list") {
                const servers = yield* registered()
                const lines = Object.entries(servers).map(([key, server]) =>
                  `- ${key} (${server.type}${server.disabled ? ", disabled" : ""}): ${
                    server.type === "local" ? server.command.join(" ") : server.url
                  }`,
                )
                return {
                  output: [
                    lines.length > 0 ? "MCP servers:" : "No MCP servers are configured.",
                    ...lines,
                    "",
                    `Generated modules live in ${path.join(Path.config, "mcp")}.`,
                  ].join("\n"),
                }
              }

              const serverName = input.name?.trim() ?? ""
              const badName = McpForge.nameProblem(serverName)
              if (badName) return yield* new ToolFailure({ message: badName })
              const source =
                input.source ??
                (input.server ? "server" : input.openapi !== undefined ? "openapi" : input.cli ? "cli" : input.tools ? "tools" : undefined)
              if (!source)
                return yield* new ToolFailure({
                  message:
                    "Describe where the server comes from: tools you designed, an openapi document, a cli program, or an existing server config.",
                })
              const existing = (yield* registered())[serverName]
              if (existing && input.action === "save" && input.overwrite !== true)
                return yield* new ToolFailure({
                  message: `The config already has a server named ${serverName}. Pass overwrite: true to replace it, or choose another name.`,
                })

              if (source === "server") {
                if (!input.server)
                  return yield* new ToolFailure({
                    message: 'Source server needs the server config, e.g. { type: "local", command: ["npx", "-y", "pkg"] } or { type: "remote", url: "https://..." }.',
                  })
                if (input.action === "preview")
                  return {
                    output: [
                      `Server: ${serverName} (registered as it is; no module is written)`,
                      JSON.stringify(input.server, null, 2),
                      "Ready to save.",
                    ].join("\n"),
                  }
                yield* register(serverName, input.server)
                return {
                  output: `Registered ${serverName} in the global config. The app connects it after the config reload.`,
                }
              }

              const built = yield* Effect.try({
                try: () => build(source, input, serverName),
                catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
              })
              const problems = McpForge.validate(built.spec)
              const target = input.path ? path.resolve(input.path) : path.join(Path.config, "mcp", `${serverName}.mjs`)

              if (input.action === "preview") return { output: summarize(built, problems, target) }
              if (problems.length > 0)
                return yield* new ToolFailure({
                  message: `The server is not valid, so nothing was saved:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
                })

              const runtime = Bun.which("node") ? "node" : Bun.which("bun") ? "bun" : undefined
              if (!runtime)
                return yield* new ToolFailure({
                  message:
                    "Neither Node nor Bun is on PATH, so the generated server could not start. Install Node 18+ and save again.",
                })
              const exists = yield* Effect.promise(() => Bun.file(target).exists())
              if (exists && input.overwrite !== true)
                return yield* new ToolFailure({
                  message: `${target} already exists. Pass overwrite: true to replace it, or choose another name.`,
                })
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(path.dirname(target), { recursive: true })
                  await Bun.write(target, McpForge.render(built.spec))
                },
                catch: (error) =>
                  new ToolFailure({
                    message: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
                  }),
              })
              yield* register(serverName, { type: "local", command: [runtime, target] })

              return {
                output: [
                  `Wrote ${target}.`,
                  `Registered ${serverName} in the global config as \`${runtime} ${target}\`.`,
                  `The app connects it right after the config reload; its tools appear with the prefix ${serverName}_.`,
                  ...(built.warnings.length > 0
                    ? ["", "Warnings:", ...built.warnings.map((warning) => `- ${warning}`)]
                    : []),
                ].join("\n"),
              }
            }).pipe(Effect.map((output) => ({ output, content: output.output }))),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.command.transform((editor) =>
      editor.add({
        name: command,
        description:
          "Build and register an MCP server from tools you describe, an OpenAPI document, a command line program, or an existing server [request]",
        execute: (input) =>
          ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: prompt(input.prompt.text.trim()),
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      }),
    )
  }),
}

type Draft = Schema.Schema.Type<typeof Input>

function build(source: "tools" | "openapi" | "cli", input: Draft, name: string) {
  if (source === "openapi") {
    if (input.openapi === undefined)
      throw new Error("Source openapi needs the document: the parsed JSON object or its JSON text.")
    const document = typeof input.openapi === "string" ? parseJson(input.openapi) : input.openapi
    return McpForge.fromOpenApi(document, {
      name,
      baseUrl: input.baseUrl,
      methods: input.methods,
      limit: input.limit,
      headers: input.headers,
    })
  }
  if (source === "cli") {
    if (!input.cli) throw new Error("Source cli needs cli: { command, subcommands }.")
    return { spec: McpForge.fromCli(input.cli, name), warnings: [] }
  }
  if (!input.tools || input.tools.length === 0) throw new Error("Source tools needs tools: at least one designed tool.")
  return { spec: { name, description: input.description, tools: input.tools }, warnings: [] }
}

function parseJson(text: string) {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text)
  if (Option.isNone(parsed)) throw new Error("openapi is not valid JSON text.")
  return parsed.value
}

function summarize(built: { spec: McpForge.ServerSpec; warnings: readonly string[] }, problems: readonly string[], target: string) {
  return [
    `Server: ${built.spec.name}${built.spec.description ? ` — ${built.spec.description}` : ""}`,
    `Tools (${built.spec.tools.length}):`,
    ...built.spec.tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    ...(built.warnings.length > 0 ? ["", "Warnings:", ...built.warnings.map((warning) => `- ${warning}`)] : []),
    ...(problems.length > 0 ? ["", "Problems:", ...problems.map((problem) => `- ${problem}`)] : []),
    "",
    problems.length > 0 ? "Not ready to save; fix the problems above." : "Ready to save.",
    `Target: ${target}`,
  ].join("\n")
}

function prompt(request: string) {
  return [
    "You are the MCP forge: you turn the operator's request into a working MCP server, end to end.",
    request
      ? `Operator request: ${request}`
      : "The operator did not describe a server yet. Ask one concise question about what the server should do and which system it talks to.",
    "",
    "Workflow:",
    "1. Call mcp_forge action=list. Never reuse an existing server name.",
    "2. Choose the source that fits: tools when the request describes capabilities you can implement over HTTP or a command; openapi when the operator names an OpenAPI or Swagger document; cli when an installed program should be wrapped; server when the server already exists and only needs registering.",
    "3. Call mcp_forge action=preview with the complete description and read the problems and warnings. Fix every problem; resolve warnings or say why they stay.",
    "4. Call mcp_forge action=save with the same input once preview is clean.",
    "5. Report the name, what each tool does, where the module was written, and that the tools appear with the prefix <name>_ after the config reloads.",
    "",
    "Rules:",
    "- Design few, sharp tools with clear descriptions and typed arguments; the model that calls them sees only their names and descriptions.",
    "- A tool that changes state must say so in its description; never invent a destructive tool.",
    "- Never put a token or password in the module. A header value uses ${ENV_NAME}; the operator sets that variable in the server environment (mcp.servers.<name>.environment).",
    "- Never overwrite an existing module or server unless the operator explicitly asked for that exact change; use another name instead.",
    "- When the OpenAPI document has not been provided, ask for its file, URL or text instead of guessing the API.",
  ].join("\n")
}

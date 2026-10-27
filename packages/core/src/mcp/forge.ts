export * as McpForge from "./forge.js"

import { Schema } from "effect"

// Turns a description of tools into a ready MCP server: one self-contained ES module that speaks MCP over
// stdio and needs nothing installed beyond Node. The description comes from the model (tools it designed),
// from an OpenAPI document, or from a command line program. Nothing secret is written into the module:
// headers read `${NAME}` from the environment of the process that runs it.

const Property = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean"]),
  description: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
})

const Exec = Schema.Struct({
  type: Schema.Literal("exec"),
  argv: Schema.Array(Schema.String).annotate({
    description:
      "Program and arguments, run without a shell. {{param}} inside an element is replaced by the tool argument; an element that names an argument the caller left out is dropped.",
  }),
  cwd: Schema.optionalKey(Schema.String),
})

const Http = Schema.Struct({
  type: Schema.Literal("http"),
  method: Schema.String,
  url: Schema.String.annotate({ description: "Absolute URL; {{param}} is replaced by the URL-encoded tool argument." }),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Header values may use ${ENV_NAME}, read from the server's environment when it runs.",
  }),
  query: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Names of the tool arguments sent as query parameters.",
  }),
  body: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Names of the tool arguments sent as fields of a JSON body.",
  }),
  bodyJson: Schema.optionalKey(Schema.String).annotate({
    description: "Name of the one argument whose value is the whole JSON body.",
  }),
})

export const Run = Schema.Union([Exec, Http])
export type Run = typeof Run.Type

export const ToolSpec = Schema.Struct({
  name: Schema.String.annotate({ description: "Letters, digits and underscores; starts with a letter; at most 64." }),
  description: Schema.String,
  properties: Schema.Record(Schema.String, Property),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  run: Run,
})
export interface ToolSpec extends Schema.Schema.Type<typeof ToolSpec> {}

export const ServerSpec = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tools: Schema.Array(ToolSpec),
})
export interface ServerSpec extends Schema.Schema.Type<typeof ServerSpec> {}

export const Cli = Schema.Struct({
  command: Schema.String.annotate({ description: "The program, as found on PATH or an absolute path." }),
  subcommands: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Subcommand words, e.g. `status` or `remote add`. Empty for the program itself." }),
      description: Schema.String,
      args: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String.annotate({ description: "Argument name: letters, digits and underscores." }),
            description: Schema.optionalKey(Schema.String),
            type: Schema.optionalKey(Schema.Literals(["string", "number", "integer", "boolean"])),
            flag: Schema.optionalKey(Schema.String).annotate({
              description: "Option name such as --limit; sent as --limit=value. Omit for a positional argument.",
            }),
            required: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      ),
    }),
  ),
})
export interface Cli extends Schema.Schema.Type<typeof Cli> {}

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,40}$/
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Why a server name cannot be used, or undefined when it is valid. */
export function nameProblem(name: string) {
  if (SERVER_NAME.test(name)) return undefined
  return `Server name "${name}" must be lowercase letters, digits, - or _, starting with a letter.`
}

/** Every problem that would make the server wrong or unsafe to generate; empty when the spec is sound. */
export function validate(spec: ServerSpec) {
  const problems: string[] = []
  const badName = nameProblem(spec.name)
  if (badName) problems.push(badName)
  if (spec.tools.length === 0) problems.push("The server needs at least one tool.")
  const seen = new Set<string>()
  for (const tool of spec.tools) {
    if (!TOOL_NAME.test(tool.name)) problems.push(`Tool name "${tool.name}" must be letters, digits and underscores.`)
    if (seen.has(tool.name)) problems.push(`Tool name "${tool.name}" is used twice.`)
    seen.add(tool.name)
    const declared = new Set(Object.keys(tool.properties))
    for (const name of declared)
      if (!/^\w+$/.test(name)) problems.push(`${tool.name}: argument "${name}" must be letters, digits and underscores.`)
    for (const name of tool.required ?? [])
      if (!declared.has(name)) problems.push(`${tool.name}: required argument "${name}" is not declared.`)
    for (const name of referenced(tool.run))
      if (!declared.has(name)) problems.push(`${tool.name}: {{${name}}} is not a declared argument.`)
    if (tool.run.type === "exec" && (tool.run.argv.length === 0 || !tool.run.argv[0] || tool.run.argv[0].includes("{{")))
      problems.push(`${tool.name}: the program (first element of argv) must be fixed text.`)
    if (tool.run.type === "http") {
      if (!/^https?:\/\//i.test(tool.run.url)) problems.push(`${tool.name}: url must start with http:// or https://.`)
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(tool.run.method))
        problems.push(`${tool.name}: method ${tool.run.method} is not supported.`)
      for (const name of [...(tool.run.query ?? []), ...(tool.run.body ?? []), ...(tool.run.bodyJson ? [tool.run.bodyJson] : [])])
        if (!declared.has(name)) problems.push(`${tool.name}: "${name}" is sent but not declared as an argument.`)
    }
  }
  return problems
}

function referenced(run: Run) {
  const texts = run.type === "exec" ? run.argv : [run.url, ...Object.values(run.headers ?? {})]
  return texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!))
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Follows a local `$ref` such as #/components/schemas/Pet; anything else is returned as it is. */
function deref(root: Json, value: unknown, depth = 0): unknown {
  if (!isObject(value) || typeof value.$ref !== "string" || depth > 8) return value
  const target = value.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>(
      (current, part) => (isObject(current) ? current[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined),
      root,
    )
  return deref(root, target, depth + 1)
}

type PropertySpec = {
  type: "string" | "number" | "integer" | "boolean"
  description?: string
  enum?: readonly string[]
}

function property(root: Json, schema: unknown, fallback: string): PropertySpec {
  const resolved = deref(root, schema)
  const found = isObject(resolved) ? resolved : {}
  const kind = found.type
  const choices = Array.isArray(found.enum) ? found.enum.filter((item): item is string => typeof item === "string") : []
  const description = typeof found.description === "string" ? found.description : fallback
  const type = kind === "number" ? "number" : kind === "integer" ? "integer" : kind === "boolean" ? "boolean" : "string"
  return {
    type,
    description: kind === "string" || type !== "string" ? description : `${description} (JSON text)`.trim(),
    ...(choices.length > 0 ? { enum: choices } : {}),
  }
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const

/**
 * One HTTP tool for each operation of an OpenAPI 3 (or Swagger 2) document. Path and query parameters and
 * JSON body fields become the tool's arguments. Header and cookie parameters are left to `headers`.
 */
export function fromOpenApi(
  document: unknown,
  options: {
    name: string
    baseUrl?: string
    methods?: readonly string[]
    limit?: number
    headers?: Readonly<Record<string, string>>
  },
) {
  if (!isObject(document) || !isObject(document.paths))
    throw new Error("This is not an OpenAPI document: it has no `paths`.")
  const root = document
  const paths = document.paths
  const warnings: string[] = []
  const servers = Array.isArray(root.servers) ? root.servers : []
  const first = isObject(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : undefined
  const swagger =
    typeof root.host === "string"
      ? `${Array.isArray(root.schemes) && typeof root.schemes[0] === "string" ? root.schemes[0] : "https"}://${root.host}${typeof root.basePath === "string" ? root.basePath : ""}`
      : undefined
  const base = (options.baseUrl ?? first ?? swagger)?.replace(/\/+$/, "")
  if (!base || !/^https?:\/\//i.test(base))
    throw new Error("The document has no absolute server URL. Pass baseUrl, e.g. https://api.example.com/v1.")
  const wanted = new Set((options.methods ?? METHODS).map((method) => method.toLowerCase()))
  const limit = options.limit ?? 80
  const used = new Set<string>()
  const tools: ToolSpec[] = []
  let skipped = 0

  for (const [route, item] of Object.entries(paths)) {
    const path = deref(root, item)
    if (!isObject(path)) continue
    for (const method of METHODS) {
      const operation = deref(root, path[method])
      if (!wanted.has(method) || !isObject(operation)) continue
      if (tools.length >= limit) {
        skipped += 1
        continue
      }
      const name = unique(used, toolName(operation.operationId, method, route))
      const properties: Record<string, PropertySpec> = {}
      const required: string[] = []
      const query: string[] = []
      const body: string[] = []
      const parameters = [
        ...(Array.isArray(path.parameters) ? path.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ].map((value) => deref(root, value))

      for (const parameter of parameters) {
        if (!isObject(parameter) || typeof parameter.name !== "string") continue
        if (parameter.in !== "path" && parameter.in !== "query") continue
        if (!/^\w+$/.test(parameter.name)) {
          warnings.push(`${name}: parameter "${parameter.name}" skipped; its name is not letters, digits and underscores.`)
          continue
        }
        properties[parameter.name] = property(root, parameter.schema ?? parameter, "")
        if (parameter.in === "path" || parameter.required === true) required.push(parameter.name)
        if (parameter.in === "query") query.push(parameter.name)
      }

      let bodyJson: string | undefined
      const content = isObject(deref(root, operation.requestBody)) ? (deref(root, operation.requestBody) as Json).content : undefined
      const media = isObject(content) ? deref(root, content["application/json"]) : undefined
      const schema = isObject(media) ? deref(root, media.schema) : undefined
      if (isObject(schema)) {
        const fields = isObject(schema.properties) ? schema.properties : undefined
        const needed = Array.isArray(schema.required) ? schema.required : []
        if (fields && Object.keys(fields).every((field) => /^\w+$/.test(field))) {
          for (const [field, definition] of Object.entries(fields)) {
            const key = field in properties ? `body_${field}` : field
            properties[key] = property(root, definition, "")
            body.push(key)
            if (needed.includes(field)) required.push(key)
          }
        } else {
          bodyJson = "body"
          properties.body = { type: "string", description: "The JSON request body, as JSON text." }
          required.push("body")
        }
      }

      const summary = [operation.summary, operation.description].find((text): text is string => typeof text === "string")
      tools.push({
        name,
        description: `${method.toUpperCase()} ${route}${summary ? ` — ${summary.trim().split("\n")[0]}` : ""}`.slice(0, 500),
        properties,
        required: [...new Set(required)],
        run: {
          type: "http",
          method: method.toUpperCase(),
          url: base + route.replace(/\{([^}]+)\}/g, (_, key: string) => `{{${key.replace(/\W/g, "_")}}}`),
          ...(options.headers && Object.keys(options.headers).length > 0 ? { headers: { ...options.headers } } : {}),
          ...(query.length > 0 ? { query } : {}),
          ...(body.length > 0 ? { body } : {}),
          ...(bodyJson ? { bodyJson } : {}),
        },
      })
    }
  }
  if (skipped > 0) warnings.push(`${skipped} more operations were left out by the limit of ${limit}; raise limit or filter methods.`)
  const title = isObject(root.info) && typeof root.info.title === "string" ? root.info.title : undefined
  return { spec: { name: options.name, description: title, tools } satisfies ServerSpec, warnings }
}

function toolName(operationId: unknown, method: string, route: string) {
  const raw = typeof operationId === "string" && operationId ? operationId : `${method}_${route}`
  const cleaned = raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return (/^[a-zA-Z]/.test(cleaned) ? cleaned : `op_${cleaned}`).slice(0, 64)
}

function unique(used: Set<string>, name: string) {
  let candidate = name
  for (let index = 2; used.has(candidate); index += 1) candidate = `${name.slice(0, 60)}_${index}`
  used.add(candidate)
  return candidate
}

/** One tool for each subcommand of a command line program, run without a shell. */
export function fromCli(cli: Cli, name: string): ServerSpec {
  const used = new Set<string>()
  return {
    name,
    description: `Wraps ${cli.command}`,
    tools: cli.subcommands.map((sub) => {
      const words = sub.name.split(/\s+/).filter(Boolean)
      const args = sub.args ?? []
      const tool = [cli.command.replace(/^.*[\\/]/, ""), ...words].join("_")
      return {
        name: unique(used, toolName(tool, "run", "")),
        description: sub.description,
        properties: Object.fromEntries(
          args.map((arg) => [
            arg.name,
            { type: arg.type ?? "string", ...(arg.description ? { description: arg.description } : {}) },
          ]),
        ),
        required: args.filter((arg) => arg.required).map((arg) => arg.name),
        run: {
          type: "exec" as const,
          argv: [
            cli.command,
            ...words,
            ...args.map((arg) => (arg.flag ? `${arg.flag}={{${arg.name}}}` : `{{${arg.name}}}`)),
          ],
        },
      }
    }),
  }
}

/** The source of the server: the spec as data plus a fixed MCP stdio runtime. */
export function render(spec: ServerSpec) {
  return RUNTIME.replace("__SPEC__", () => JSON.stringify(spec, null, 2))
}

const RUNTIME = `#!/usr/bin/env node
// Generated by Orchestra's mcp_forge. Edit the tools below or regenerate; keep secrets in the environment.
import { spawn } from "node:child_process"

const SPEC = __SPEC__
const LIMIT = 100000
const TIMEOUT = 60000

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
const text = (value, isError = false) => ({ content: [{ type: "text", text: String(value) }], isError })
const names = (template) => [...template.matchAll(/\\{\\{(\\w+)\\}\\}/g)].map((match) => match[1])
const missing = (template, args) => names(template).some((name) => args[name] === undefined)
const fill = (template, args, encode) =>
  template.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => (args[name] === undefined ? "" : encode ? encodeURIComponent(args[name]) : String(args[name])))
const environment = (value) => value.replace(/\\$\\{(\\w+)\\}/g, (_, name) => process.env[name] ?? "")
const clip = (value) => (value.length > LIMIT ? value.slice(0, LIMIT) + "\\n[output cut at " + LIMIT + " characters]" : value)

function coerce(tool, input) {
  const args = {}
  for (const [name, definition] of Object.entries(tool.properties)) {
    const value = input?.[name]
    if (value === undefined || value === null) continue
    if (definition.type === "number" || definition.type === "integer") args[name] = Number(value)
    else if (definition.type === "boolean") args[name] = value === true || value === "true"
    else args[name] = String(value)
  }
  for (const name of tool.required ?? []) if (args[name] === undefined) throw new Error("Missing required argument: " + name)
  return args
}

function exec(run, args) {
  const argv = run.argv.filter((part) => !missing(part, args)).map((part) => fill(part, args, false))
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: run.cwd || undefined, windowsHide: true })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill(), TIMEOUT)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve(text("Could not run " + argv[0] + ": " + error.message, true))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const body = clip(out + (err ? "\\n[stderr]\\n" + err : ""))
      resolve(text(code === 0 ? body || "(no output)" : "Exit code " + code + "\\n" + body, code !== 0))
    })
  })
}

async function http(run, args) {
  const url = new URL(fill(run.url, args, true))
  for (const name of run.query || []) if (args[name] !== undefined) url.searchParams.set(name, String(args[name]))
  const headers = Object.fromEntries(Object.entries(run.headers || {}).map(([key, value]) => [key, environment(value)]))
  let body
  if (run.bodyJson && args[run.bodyJson] !== undefined) body = String(args[run.bodyJson])
  else if (run.body && run.body.length > 0) body = JSON.stringify(Object.fromEntries(run.body.filter((name) => args[name] !== undefined).map((name) => [name, args[name]])))
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json"
  const response = await fetch(url, { method: run.method, headers, body: run.method === "GET" || run.method === "HEAD" ? undefined : body, signal: AbortSignal.timeout(TIMEOUT) })
  const payload = clip(await response.text())
  return text(response.status + " " + response.statusText + "\\n" + payload, !response.ok)
}

async function call(name, input) {
  const tool = SPEC.tools.find((item) => item.name === name)
  if (!tool) return text("Unknown tool: " + name, true)
  try {
    const args = coerce(tool, input)
    return tool.run.type === "exec" ? await exec(tool.run, args) : await http(tool.run, args)
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true)
  }
}

async function handle(message) {
  const { id, method, params } = message
  if (method === "initialize")
    return send({ id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SPEC.name, version: "1.0.0" } } })
  if (method === "ping") return send({ id, result: {} })
  if (method === "tools/list")
    return send({
      id,
      result: {
        tools: SPEC.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object", properties: tool.properties, required: tool.required || [] },
        })),
      },
    })
  if (method === "tools/call") return send({ id, result: await call(params?.name, params?.arguments) })
  if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found: " + method } })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf("\\n"); end !== -1; end = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line))
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } })
    }
  }
})
`

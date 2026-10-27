import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fromCli, fromOpenApi, render, validate, type ServerSpec } from "../src/mcp/forge"
import { tmpdir } from "./fixture/tmpdir"

describe("mcp forge", () => {
  test("accepts a sound spec and names every fault it can see", () => {
    const good: ServerSpec = {
      name: "echo",
      tools: [
        {
          name: "say",
          description: "Echo the text back.",
          properties: { text: { type: "string" } },
          required: ["text"],
          run: { type: "exec", argv: ["echo", "{{text}}"] },
        },
      ],
    }
    expect(validate(good)).toEqual([])

    const problems = validate({
      name: "Bad Name",
      tools: [
        {
          name: "1bad",
          description: "",
          properties: { "a-b": { type: "string" } },
          required: ["missing"],
          run: { type: "exec", argv: ["echo", "{{nope}}"] },
        },
        {
          name: "http_tool",
          description: "",
          properties: {},
          run: { type: "http", method: "FETCH", url: "ftp://example.com" },
        },
        {
          name: "http_tool",
          description: "",
          properties: {},
          run: { type: "http", method: "GET", url: "https://example.com", query: ["q"] },
        },
      ],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        'Server name "Bad Name" must be lowercase letters, digits, - or _, starting with a letter.',
        'Tool name "1bad" must be letters, digits and underscores.',
        '1bad: argument "a-b" must be letters, digits and underscores.',
        '1bad: required argument "missing" is not declared.',
        '1bad: {{nope}} is not a declared argument.',
        "http_tool: method FETCH is not supported.",
        "http_tool: url must start with http:// or https://.",
        'Tool name "http_tool" is used twice.',
        'http_tool: "q" is sent but not declared as an argument.',
      ]),
    )
  })

  test("turns OpenAPI operations into HTTP tools", () => {
    const document = {
      openapi: "3.0.0",
      info: { title: "Pets", version: "1" },
      servers: [{ url: "https://api.example.com/v1/" }],
      components: {
        schemas: {
          Expand: { type: "string", enum: ["yes", "no"], description: "Expand relations" },
        },
      },
      paths: {
        "/pets/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getPet",
            summary: "Fetch one pet",
            parameters: [{ name: "expand", in: "query", schema: { $ref: "#/components/schemas/Expand" } }],
          },
          post: {
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" }, age: { type: "integer" } },
                    required: ["name"],
                  },
                },
              },
            },
          },
        },
      },
    }

    const built = fromOpenApi(document, { name: "pets" })
    expect(built.spec.description).toBe("Pets")
    expect(built.warnings).toEqual([])

    const get = built.spec.tools.find((tool) => tool.name === "getPet")!
    expect(get.description).toBe("GET /pets/{id} — Fetch one pet")
    expect(get.required).toEqual(["id"])
    expect(get.properties.expand).toEqual({ type: "string", description: "Expand relations", enum: ["yes", "no"] })
    expect(get.run).toEqual({
      type: "http",
      method: "GET",
      url: "https://api.example.com/v1/pets/{{id}}",
      query: ["expand"],
    })

    const post = built.spec.tools.find((tool) => tool.name === "createPet")!
    expect(post.required).toEqual(["id", "name"])
    expect(post.run).toEqual({
      type: "http",
      method: "POST",
      url: "https://api.example.com/v1/pets/{{id}}",
      body: ["name", "age"],
    })

    const limited = fromOpenApi(document, { name: "pets", methods: ["GET"], limit: 1 })
    expect(limited.spec.tools.map((tool) => tool.name)).toEqual(["getPet"])
    expect(limited.warnings).toEqual([])
  })

  test("requires an absolute base URL", () => {
    expect(() => fromOpenApi({ paths: {} }, { name: "pets" })).toThrow("no absolute server URL")
  })

  test("wraps subcommands of a command line program without a shell", () => {
    const spec = fromCli(
      {
        command: "git",
        subcommands: [
          {
            name: "remote add",
            description: "Add a remote",
            args: [
              { name: "name", required: true },
              { name: "url", required: true },
              { name: "fetch", type: "boolean", flag: "--fetch", description: "Fetch after adding" },
            ],
          },
        ],
      },
      "git",
    )

    expect(spec.tools).toHaveLength(1)
    expect(spec.tools[0]!.name).toBe("git_remote_add")
    expect(spec.tools[0]!.required).toEqual(["name", "url"])
    expect(spec.tools[0]!.properties.fetch).toEqual({ type: "boolean", description: "Fetch after adding" })
    expect(spec.tools[0]!.run).toEqual({
      type: "exec",
      argv: ["git", "remote", "add", "{{name}}", "{{url}}", "--fetch={{fetch}}"],
    })
  })

  test("the rendered module speaks MCP over stdio", async () => {
    const spec: ServerSpec = {
      name: "echo",
      description: "Test server",
      tools: [
        {
          name: "say",
          description: "Echo the text back.",
          properties: { text: { type: "string", description: "Text to echo." } },
          required: ["text"],
          run: { type: "exec", argv: [process.execPath, "-e", "console.log(process.argv[1])", "{{text}}"] },
        },
        {
          name: "fail",
          description: "Exit with a failure.",
          properties: {},
          run: { type: "exec", argv: [process.execPath, "-e", "process.exit(3)"] },
        },
      ],
    }

    const tmp = await tmpdir()
    try {
      const file = path.join(tmp.path, "echo.mjs")
      await Bun.write(file, render(spec))
      const child = Bun.spawn([process.execPath, file], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "say", arguments: { text: "hello" } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail", arguments: {} } },
        { jsonrpc: "2.0", id: 5, method: "nope" },
      ]
      child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n")
      child.stdin.end()

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)

      const responses = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ServerResponse)
      const response = (id: number) => responses.find((item) => item.id === id)!

      expect(response(1).result?.serverInfo?.name).toBe("echo")
      expect(response(2).result?.tools?.map((tool) => tool.name)).toEqual(["say", "fail"])
      expect(response(3).result?.content?.[0]?.text).toBe("hello\n")
      expect(response(3).result?.isError).toBe(false)
      expect(response(4).result?.isError).toBe(true)
      expect(response(4).result?.content?.[0]?.text).toContain("Exit code 3")
      expect(response(5).error?.code).toBe(-32601)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})

interface ServerResponse {
  readonly id: number
  readonly result?: {
    readonly serverInfo?: { readonly name: string }
    readonly tools?: ReadonlyArray<{ readonly name: string }>
    readonly content?: ReadonlyArray<{ readonly text: string }>
    readonly isError?: boolean
  }
  readonly error?: { readonly code: number; readonly message: string }
}

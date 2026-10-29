import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"
import { OpenCode } from "../src/opencode.js"
import type { Context } from "../src/promise/plugin.js"

// The connector only touches a few domains, so the test host implements just those.
function host(credential?: { type: "oauth"; methodID: string; refresh: string; access: string; expires: number }) {
  const methods: any[] = []
  const tools: any[] = []
  const optionHooks: Array<{ callback: (event: any) => Promise<void> | void; providerID?: string }> = []
  const storage = new Map<string, unknown>()
  const ctx = {
    location: { directory: "/work", project: { id: "prj_test" } },
    options: {},
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
    },
    event: { subscribe: () => (async function* () {})() },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ method: { update: (method: unknown) => methods.push(method) } })
        return { dispose: async () => undefined }
      },
      connection: {
        active: async () => (credential ? { type: "credential", id: "cred_1" } : undefined),
        resolve: async () => credential,
      },
    },
    aisdk: {
      hook: async (_name: string, callback: (event: any) => void, options?: { providerID?: string }) => {
        optionHooks.push({ callback, providerID: options?.providerID })
        return { dispose: async () => undefined }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: unknown) => tools.push(tool) })
        return { dispose: async () => undefined }
      },
    },
  } as unknown as Context
  return { ctx, methods, tools, optionHooks, storage }
}

describe("OpenCode.detect", () => {
  it("accepts a default function, a server module, and named function exports", () => {
    const fn = async () => ({})
    assert.deepEqual(OpenCode.detect({ default: fn }), [fn])
    assert.deepEqual(OpenCode.detect({ default: { server: fn } }), [fn])
    assert.deepEqual(OpenCode.detect({ First: fn, notAPlugin: 1 }), [fn])
  })

  it("rejects modules that are not plugins", () => {
    assert.equal(OpenCode.detect({ default: { id: "native", setup: () => undefined }, helper: () => 1 }), undefined)
    assert.equal(OpenCode.detect({ value: 1 }), undefined)
  })
})

describe("OpenCode.fromOpenCode", () => {
  it("registers oauth methods and completes an automatic authorization", async () => {
    const { ctx, methods } = host()
    const plugin = OpenCode.fromOpenCode({
      id: "fixture",
      plugins: [
        async () => ({
          auth: {
            provider: "fixture",
            methods: [
              {
                type: "oauth",
                label: "Sign in",
                authorize: async () => ({
                  url: "https://example.test/login",
                  instructions: "Open the page",
                  method: "auto",
                  callback: async () => ({ type: "success", refresh: "r", access: "a", expires: 1000, accountId: "acc" }),
                }),
              },
            ],
          },
        }),
      ],
    })
    await plugin.setup(ctx)
    assert.equal(methods.length, 1)
    assert.equal(methods[0].integrationID, "fixture")
    assert.equal(methods[0].method.label, "Sign in")
    const authorization = await methods[0].authorize({})
    assert.equal(authorization.mode, "auto")
    const credential = await authorization.callback
    assert.equal(credential.access, "a")
    assert.equal(credential.refresh, "r")
    assert.deepEqual(credential.metadata, { accountId: "acc" })
  })

  it("supports code authorization and reports failed results", async () => {
    const { ctx, methods } = host()
    await OpenCode.fromOpenCode({
      id: "fixture",
      plugins: [
        async () => ({
          auth: {
            provider: "fixture",
            methods: [
              {
                type: "oauth",
                label: "Code",
                authorize: async () => ({
                  url: "https://example.test",
                  instructions: "Paste the code",
                  method: "code",
                  callback: async (code: string) =>
                    code === "good" ? { type: "success", key: "secret" } : { type: "failed" },
                }),
              },
            ],
          },
        }),
      ],
    }).setup(ctx)
    const authorization = await methods[0].authorize({})
    assert.equal(authorization.mode, "code")
    assert.equal((await authorization.callback("good")).access, "secret")
    await assert.rejects(authorization.callback("bad"), /Authorization failed/)
  })

  it("turns prompts into form fields, deriving conditions from selects", async () => {
    const { ctx, methods } = host()
    await OpenCode.fromOpenCode({
      id: "fixture",
      plugins: [
        async () => ({
          auth: {
            provider: "fixture",
            methods: [
              {
                type: "oauth",
                label: "Enterprise",
                prompts: [
                  {
                    type: "select",
                    key: "deployment",
                    message: "Deployment",
                    options: [
                      { label: "Public", value: "public" },
                      { label: "Enterprise", value: "enterprise" },
                    ],
                  },
                  {
                    type: "text",
                    key: "domain",
                    message: "Domain",
                    condition: (inputs: Record<string, string>) => inputs.deployment === "enterprise",
                  },
                ],
                authorize: async () => {
                  throw new Error("unused")
                },
              },
            ],
          },
        }),
      ],
    }).setup(ctx)
    const form = methods[0].method.form
    assert.equal(form[0].options.length, 2)
    assert.deepEqual(form[1].when, [{ key: "deployment", op: "eq", value: "enterprise" }])
  })

  it("applies the loader to SDK options and follows token refreshes", async () => {
    const { ctx, optionHooks, storage } = host({
      type: "oauth",
      methodID: "opencode-0",
      refresh: "r1",
      access: "a1",
      expires: 10,
    })
    const seen: string[] = []
    let setAuth: ((request: unknown) => Promise<unknown>) | undefined
    await OpenCode.fromOpenCode({
      id: "fixture",
      plugins: [
        async (input) => {
          setAuth = (request) => (input.client as any).auth.set(request)
          return {
            auth: {
              provider: "fixture",
              methods: [],
              loader: async (getAuth) => ({
                apiKey: "",
                async fetch(_input: RequestInfo | URL) {
                  const auth = await getAuth()
                  seen.push(auth.type === "oauth" ? auth.access : auth.type)
                  return new Response("ok")
                },
              }),
            },
          }
        },
      ],
    }).setup(ctx)

    assert.equal(optionHooks.length, 1)
    assert.equal(optionHooks[0]?.providerID, "fixture")
    const event = { options: {} as Record<string, any> }
    await optionHooks[0]?.callback(event)
    assert.equal(event.options.apiKey, "")
    await event.options.fetch("https://example.test")
    await setAuth?.({ path: { id: "fixture" }, body: { type: "oauth", refresh: "r2", access: "a2", expires: 20 } })
    await event.options.fetch("https://example.test")
    assert.deepEqual(seen, ["a1", "a2"])
    assert.ok([...storage.keys()].some((key) => key.includes("cred_1")))
  })

  it("registers tools with a JSON schema and runs them", async () => {
    const { ctx, tools } = host()
    await OpenCode.fromOpenCode({
      id: "fixture",
      plugins: [
        async () => ({
          tool: {
            echo: {
              description: "Echo text",
              args: { text: z.string() },
              execute: async (args: Record<string, unknown>) => `echo:${args.text}`,
            },
          },
        }),
      ],
    }).setup(ctx)
    assert.equal(tools[0].name, "echo")
    assert.equal(tools[0].input.properties.text.type, "string")
    const result = await tools[0].execute(
      { text: "hi" },
      { sessionID: "ses_1", messageID: "msg_1", agent: "build", signal: new AbortController().signal, progress: async () => undefined },
    )
    assert.equal(result.content, "echo:hi")
    await assert.rejects(tools[0].execute({ text: 1 }, { signal: new AbortController().signal }))
  })
})

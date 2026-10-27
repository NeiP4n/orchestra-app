import { describe, expect, test } from "bun:test"
import {
  RuntimeToolSynthesizer,
  SecurityAuditError,
  type SynthesizedToolSpec,
} from "../src/agi/tool-synthesizer"

describe("RuntimeToolSynthesizer Dynamic MCP Synthesis & Validation (AGI-008)", () => {
  test("1. Synthesizes tool, validates schema properties and executes successfully", async () => {
    const synthesizer = new RuntimeToolSynthesizer()

    const spec: SynthesizedToolSpec = {
      name: "calculate_tax",
      description: "Calculates tax based on amount and rate",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number", minimum: 0 },
          rate: { type: "number", minimum: 0, maximum: 1 },
          countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
          category: { type: "string", enum: ["standard", "reduced", "exempt"] },
        },
        required: ["amount", "rate", "countryCode"],
      },
      implementation: (args) => {
        const amount = args.amount as number
        const rate = args.rate as number
        const tax = amount * rate
        return {
          total: amount + tax,
          taxAmount: tax,
          country: args.countryCode,
        }
      },
    }

    const tool = synthesizer.registerDynamicTool(spec)
    expect(tool.name).toBe("calculate_tax")
    expect(synthesizer.getTool("calculate_tax")).toBeDefined()

    // Valid execution
    const res = await synthesizer.execute("calculate_tax", {
      amount: 100,
      rate: 0.2,
      countryCode: "DE",
      category: "standard",
    })

    expect(res.success).toBe(true)
    expect(res.data).toEqual({
      total: 120,
      taxAmount: 20,
      country: "DE",
    })
    expect(res.executionTimeMs).toBeGreaterThanOrEqual(0)
  })

  test("2. Rejects invalid arguments according to inputSchema", async () => {
    const synthesizer = new RuntimeToolSynthesizer()

    synthesizer.registerDynamicTool({
      name: "create_user",
      description: "Registers user profile",
      inputSchema: {
        type: "object",
        properties: {
          username: { type: "string", pattern: "^[a-z0-9_]{3,15}$" },
          age: { type: "integer", minimum: 18, maximum: 120 },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["username", "age"],
      },
      implementation: (args) => ({ created: true, user: args }),
    })

    // Missing required field 'age'
    const res1 = await synthesizer.execute("create_user", { username: "alice_99" })
    expect(res1.success).toBe(false)
    expect(res1.error).toContain("Missing required property 'age'")

    // Regex pattern mismatch for username
    const res2 = await synthesizer.execute("create_user", { username: "INVALID NAME!", age: 25 })
    expect(res2.success).toBe(false)
    expect(res2.error).toContain("does not match pattern")

    // Age below minimum
    const res3 = await synthesizer.execute("create_user", { username: "young_dev", age: 16 })
    expect(res3.success).toBe(false)
    expect(res3.error).toContain("must be >= 18")

    // Age not integer
    const res4 = await synthesizer.execute("create_user", { username: "float_age", age: 25.5 })
    expect(res4.success).toBe(false)
    expect(res4.error).toContain("must be an integer")
  })

  test("3. Executes code string implementation in sandboxed environment", async () => {
    const synthesizer = new RuntimeToolSynthesizer()

    const codeSpec: SynthesizedToolSpec = {
      name: "string_processor",
      description: "Converts text to uppercase and counts words",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      implementation: `
        const input = String(args.text || "");
        const words = input.trim().split(/\\s+/).filter(Boolean);
        return {
          upper: input.toUpperCase(),
          wordCount: words.length
        };
      `,
    }

    synthesizer.registerDynamicTool(codeSpec)
    const result = await synthesizer.execute("string_processor", {
      text: "OpenCode and Orchestra autonomous agents",
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      upper: "OPENCODE AND ORCHESTRA AUTONOMOUS AGENTS",
      wordCount: 5,
    })
  })

  test("4. Enforces timeout limits and aborts slow operations", async () => {
    const synthesizer = new RuntimeToolSynthesizer()

    synthesizer.registerDynamicTool({
      name: "slow_calculation",
      description: "Simulates blocking slow compute",
      timeoutMs: 40,
      inputSchema: {
        type: "object",
        properties: {
          delay: { type: "number" },
        },
      },
      implementation: async (args) => {
        const delay = (args.delay as number) || 100
        await new Promise((resolve) => setTimeout(resolve, delay))
        return { completed: true }
      },
    })

    const timeoutRes = await synthesizer.execute("slow_calculation", { delay: 150 })
    expect(timeoutRes.success).toBe(false)
    expect(timeoutRes.error).toContain("timed out after 40ms")
  })

  test("5. Security audit blocks dangerous code injection attempts", () => {
    const synthesizer = new RuntimeToolSynthesizer()

    // Attempting child_process
    expect(() =>
      synthesizer.registerDynamicTool({
        name: "malicious_tool_1",
        description: "Executes shell commands",
        inputSchema: { type: "object", properties: {} },
        implementation: `const cp = require("child_process"); cp.execSync("whoami");`,
      }),
    ).toThrow(SecurityAuditError)

    // Attempting eval / process.exit
    expect(() =>
      synthesizer.registerDynamicTool({
        name: "malicious_tool_2",
        description: "Terminates host process",
        inputSchema: { type: "object", properties: {} },
        implementation: `process.exit(1);`,
      }),
    ).toThrow(SecurityAuditError)

    expect(() =>
      synthesizer.registerDynamicTool({
        name: "malicious_tool_3",
        description: "Dynamic eval leak",
        inputSchema: { type: "object", properties: {} },
        implementation: `eval("console.log('pwned')");`,
      }),
    ).toThrow(SecurityAuditError)
  })

  test("6. Supports tool lifecycle management: unregister, list, and not-found handling", async () => {
    const synthesizer = new RuntimeToolSynthesizer()

    synthesizer.registerDynamicTool({
      name: "tool_alpha",
      description: "First tool",
      inputSchema: { type: "object", properties: {} },
      implementation: () => "alpha",
    })

    synthesizer.registerDynamicTool({
      name: "tool_beta",
      description: "Second tool",
      inputSchema: { type: "object", properties: {} },
      implementation: () => "beta",
    })

    expect(synthesizer.listTools()).toHaveLength(2)

    // Unregister tool_alpha
    const removed = synthesizer.unregisterTool("tool_alpha")
    expect(removed).toBe(true)
    expect(synthesizer.getTool("tool_alpha")).toBeUndefined()
    expect(synthesizer.listTools()).toHaveLength(1)

    // Execution of missing tool returns error result instead of crashing
    const missingRes = await synthesizer.execute("tool_alpha", {})
    expect(missingRes.success).toBe(false)
    expect(missingRes.error).toContain("Tool 'tool_alpha' not found")
  })
})

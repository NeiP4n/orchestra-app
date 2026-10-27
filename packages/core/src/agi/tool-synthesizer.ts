export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  readonly description?: string
  readonly pattern?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly enum?: readonly (string | number | boolean)[]
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
}

export interface ToolInputSchema {
  readonly type: "object"
  readonly properties: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

export interface ToolExecutionContext {
  readonly signal?: AbortSignal
  readonly sessionID?: string
  readonly metadata?: Record<string, unknown>
}

export type ToolExecutionHandler = (
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<unknown> | unknown

export interface SynthesizedToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema?: ToolInputSchema
  readonly implementation: ToolExecutionHandler | string
  readonly timeoutMs?: number
  readonly tags?: readonly string[]
}

export interface SynthesizedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  readonly timeoutMs: number
  readonly tags: readonly string[]
  readonly createdAt: number
  execute(args: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult>
}

export interface ToolExecutionResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
  readonly executionTimeMs: number
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = "ValidationError"
  }
}

export class SecurityAuditError extends Error {
  constructor(
    message: string,
    readonly forbiddenPattern?: string,
  ) {
    super(message)
    this.name = "SecurityAuditError"
  }
}

export class ToolTimeoutError extends Error {
  constructor(message: string, readonly timeoutMs: number) {
    super(message)
    this.name = "ToolTimeoutError"
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ToolExecutionError"
  }
}

const DEFAULT_TOOL_TIMEOUT_MS = 5000

const FORBIDDEN_SECURITY_PATTERNS = [
  /child_process/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bprocess\.exit\b/,
  /\bprocess\.kill\b/,
  /\bprocess\.env\b/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bFunction\s*\(/,
  /\brequire\s*\(/,
  /\brmdirSync\b/,
  /\bunlinkSync\b/,
  /\bfs\.rm\b/,
  /\bfs\.unlink\b/,
]

/**
 * Validates untrusted input arguments against a declared JSON schema.
 */
export function validateToolArgs(schema?: ToolInputSchema, input: unknown = {}): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Input must be a valid JSON object", "root")
  }

  const args = input as Record<string, unknown>
  if (!schema) return args

  // 1. Check required properties
  if (schema.required) {
    for (const req of schema.required) {
      if (args[req] === undefined || args[req] === null) {
        throw new ValidationError(`Missing required property '${req}'`, req)
      }
    }
  }

  // 2. Validate individual properties
  if (schema.properties) {
    for (const [propName, propDef] of Object.entries(schema.properties)) {
      const val = args[propName]
      if (val === undefined) continue

      validateProperty(propName, propDef, val)
    }
  }

  return args
}

function validateProperty(name: string, prop: JsonSchemaProperty, value: unknown): void {
  // Enum check
  if (prop.enum && !prop.enum.includes(value as any)) {
    throw new ValidationError(
      `Property '${name}' must be one of [${prop.enum.join(", ")}], received: ${JSON.stringify(value)}`,
      name,
    )
  }

  switch (prop.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new ValidationError(`Property '${name}' must be a string`, name)
      }
      if (prop.pattern) {
        const regex = new RegExp(prop.pattern)
        if (!regex.test(value)) {
          throw new ValidationError(
            `Property '${name}' does not match pattern '${prop.pattern}'`,
            name,
          )
        }
      }
      break
    }
    case "number": {
      if (typeof value !== "number" || isNaN(value)) {
        throw new ValidationError(`Property '${name}' must be a number`, name)
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        throw new ValidationError(`Property '${name}' must be >= ${prop.minimum}`, name)
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        throw new ValidationError(`Property '${name}' must be <= ${prop.maximum}`, name)
      }
      break
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ValidationError(`Property '${name}' must be an integer`, name)
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        throw new ValidationError(`Property '${name}' must be >= ${prop.minimum}`, name)
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        throw new ValidationError(`Property '${name}' must be <= ${prop.maximum}`, name)
      }
      break
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new ValidationError(`Property '${name}' must be a boolean`, name)
      }
      break
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw new ValidationError(`Property '${name}' must be an array`, name)
      }
      if (prop.items) {
        for (let i = 0; i < value.length; i++) {
          validateProperty(`${name}[${i}]`, prop.items, value[i])
        }
      }
      break
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ValidationError(`Property '${name}' must be an object`, name)
      }
      if (prop.properties) {
        for (const [subKey, subDef] of Object.entries(prop.properties)) {
          const subVal = (value as Record<string, unknown>)[subKey]
          if (subVal !== undefined) {
            validateProperty(`${name}.${subKey}`, subDef, subVal)
          }
        }
      }
      break
    }
  }
}

/**
 * Performs security audit on generated code implementation.
 */
export function auditToolCode(code: string): void {
  for (const pattern of FORBIDDEN_SECURITY_PATTERNS) {
    if (pattern.test(code)) {
      throw new SecurityAuditError(
        `Code audit failed: forbidden pattern '${pattern.source}' detected`,
        pattern.source,
      )
    }
  }
}

/**
 * Compiles a string function body into an executable handler inside a restricted scope.
 */
function compileCodeHandler(code: string): ToolExecutionHandler {
  auditToolCode(code)

  // Creates a function taking (args, context)
  // Sandboxing: shadow dangerous globals in arguments
  const sandboxedFactory = new Function(
    "args",
    "context",
    `"use strict";
     const process = undefined;
     const require = undefined;
     const global = undefined;
     const globalThis = undefined;
     ${code}`,
  )

  return (args, context) => sandboxedFactory(args, context)
}

/**
 * Runtime tool synthesizer and dynamic registry.
 */
export class RuntimeToolSynthesizer {
  private readonly tools = new Map<string, SynthesizedTool>()
  private readonly mcpServers = new Set<string>()

  /**
   * Registers an MCP server bridge with its exposed tool definitions.
   */
  registerMcpBridge(serverName: string, toolSpecs: ReadonlyArray<SynthesizedToolSpec>): void {
    this.mcpServers.add(serverName)
    for (const spec of toolSpecs) {
      const prefixedName = spec.name.startsWith(`${serverName}_`) ? spec.name : `${serverName}_${spec.name}`
      this.registerDynamicTool({
        ...spec,
        name: prefixedName,
        tags: Array.from(new Set([...(spec.tags ?? []), "mcp", serverName])),
      })
    }
  }

  /**
   * Returns list of registered active MCP servers.
   */
  getRegisteredMcpServers(): ReadonlyArray<string> {
    return Array.from(this.mcpServers)
  }

  /**
   * Registers an autonomous skill as an executable tool.
   */
  registerSkillAsTool(
    skillName: string,
    description: string,
    handler?: ToolExecutionHandler,
  ): SynthesizedTool {
    const sanitizedName = `skill_${skillName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`
    return this.registerDynamicTool({
      name: sanitizedName,
      description,
      tags: ["skill", skillName],
      implementation: handler ?? (async (args) => ({ status: "executed", skill: skillName, args })),
    })
  }

  /**
   * Executes a registered tool by name with safety checks.
   */
  async executeTool(name: string, args: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    return this.execute(name, args, context)
  }

  /**
   * Synthesizes and audits a tool without necessarily registering it globally.
   */
  synthesizeTool(spec: SynthesizedToolSpec): SynthesizedTool {
    if (!spec.name || typeof spec.name !== "string") {
      throw new ValidationError("Tool name must be a non-empty string", "name")
    }

    let handler: ToolExecutionHandler
    if (typeof spec.implementation === "string") {
      handler = compileCodeHandler(spec.implementation)
    } else if (typeof spec.implementation === "function") {
      handler = spec.implementation
    } else {
      throw new ValidationError("Implementation must be a function or code string", "implementation")
    }

    const timeoutMs = spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const tags = spec.tags ? [...spec.tags] : []
    const createdAt = Date.now()
    const inputSchema: ToolInputSchema = spec.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    }

    const execute = async (argsInput: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const startTime = Date.now()
      try {
        // 1. Schema validation
        const validatedArgs = validateToolArgs(inputSchema, argsInput)

        // 2. Sandboxed execution with timeout race
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ToolTimeoutError(`Tool '${spec.name}' execution timed out after ${timeoutMs}ms`, timeoutMs))
          }, timeoutMs)
        })

        const runPromise = Promise.resolve().then(() => handler(validatedArgs, context))

        const rawResult = await Promise.race([runPromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer)
        })

        // 3. Output sanitization
        const sanitized = rawResult !== undefined ? JSON.parse(JSON.stringify(rawResult)) : null

        return {
          success: true,
          data: sanitized,
          executionTimeMs: Date.now() - startTime,
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          executionTimeMs: Date.now() - startTime,
        }
      }
    }

    return {
      name: spec.name,
      description: spec.description,
      inputSchema,
      timeoutMs,
      tags,
      createdAt,
      execute,
    }
  }

  /**
   * Synthesizes and registers a new dynamic MCP tool in this runtime instance.
   */
  registerDynamicTool(spec: SynthesizedToolSpec): SynthesizedTool {
    const tool = this.synthesizeTool(spec)
    this.tools.set(tool.name, tool)
    return tool
  }

  /**
   * Unregisters a dynamic tool by name.
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * Retrieves a registered tool.
   */
  getTool(name: string): SynthesizedTool | undefined {
    return this.tools.get(name)
  }

  /**
   * Lists all currently registered dynamic tools.
   */
  listTools(): ReadonlyArray<SynthesizedTool> {
    return Array.from(this.tools.values())
  }

  /**
   * Executes a registered tool by name with arguments and context.
   */
  async execute(name: string, args: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found in dynamic registry`,
        executionTimeMs: 0,
      }
    }
    return tool.execute(args, context)
  }
}

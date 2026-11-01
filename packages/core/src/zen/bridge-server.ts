import type { Server, ServerWebSocket } from "bun"

export const DEFAULT_ZEN_BRIDGE_PORT = 4097
export const DEFAULT_ZEN_BRIDGE_HOST = "127.0.0.1"
export const HEARTBEAT_TTL_MS = 5000
export const LONG_POLL_TIMEOUT_MS = 3000

export interface BridgeClientInfo {
  readonly client: string
  readonly version: string
}

export interface BridgeStatus {
  readonly connected: boolean
  readonly clientInfo?: BridgeClientInfo
  readonly port?: number
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface ClientData {
  readonly id: string
}

interface RpcItem {
  readonly id: string
  readonly action: string
  readonly params: unknown
}

interface Poller {
  readonly resolve: (item: RpcItem | null) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class ZenBridgeServer {
  private server: Server<ClientData> | null = null
  private activeWs: ServerWebSocket<ClientData> | null = null
  private clientInfo?: BridgeClientInfo
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private pollQueue: RpcItem[] = []
  private waitingPollers: Poller[] = []
  private lastSeen = 0
  private nextId = 0

  public port: number
  public readonly hostname: string
  public logging = true

  constructor(options?: { port?: number; hostname?: string; logging?: boolean }) {
    this.port = options?.port ?? DEFAULT_ZEN_BRIDGE_PORT
    this.hostname = options?.hostname ?? DEFAULT_ZEN_BRIDGE_HOST
    this.logging = options?.logging ?? true
  }

  private log(...args: unknown[]): void {
    if (this.logging) {
      console.log("[ZenBridge]", ...args)
    }
  }

  private warn(...args: unknown[]): void {
    if (this.logging) {
      console.warn("[ZenBridge]", ...args)
    }
  }

  public getCorsHeaders(req?: Request): Record<string, string> {
    const origin = req?.headers.get("origin") || "*"
    const reqHeaders = req?.headers.get("access-control-request-headers")
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": reqHeaders || "Content-Type, Authorization, X-Requested-With, *",
      "Access-Control-Max-Age": "86400",
    }
  }

  get isRunning(): boolean {
    return this.server !== null
  }

  start(port = this.port): this {
    if (this.server) {
      if (this.port === port) return this
      this.stop()
    }

    this.port = port
    this.server = Bun.serve<ClientData>({
      port: this.port,
      hostname: this.hostname,
      fetch: async (req, server) => {
        const url = new URL(req.url)
        const method = req.method.toUpperCase()
        const origin = req.headers.get("origin") ?? "none"

        // Handle CORS Preflight OPTIONS
        if (method === "OPTIONS") {
          this.log(`Preflight OPTIONS for ${url.pathname} from origin: ${origin}`)
          return new Response(null, { status: 204, headers: this.getCorsHeaders(req) })
        }

        // WebSocket upgrade
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          this.log(`WebSocket upgrade attempt from origin: ${origin}, url: ${req.url}`)
          const upgraded = server.upgrade(req, {
            data: { id: crypto.randomUUID() },
          })
          if (upgraded) {
            this.log(`WebSocket upgrade accepted for origin: ${origin}`)
            return undefined
          }
          this.warn(`WebSocket upgrade failed for origin: ${origin}`)
          return new Response("WebSocket upgrade failed", { status: 400, headers: this.getCorsHeaders(req) })
        }

        // HTTP endpoints
        if (method === "GET" && (url.pathname === "/status" || url.pathname === "/health")) {
          this.log(`HTTP ${method} ${url.pathname} from origin: ${origin}`)
          return Response.json(this.getStatus(), { headers: this.getCorsHeaders(req) })
        }

        if (method === "POST" && url.pathname === "/heartbeat") {
          return this.handleHeartbeat(req)
        }

        if (method === "GET" && url.pathname === "/poll") {
          return this.handlePoll(req)
        }

        if (method === "POST" && url.pathname === "/result") {
          return this.handleResult(req)
        }

        this.log(`HTTP ${method} ${url.pathname} default info response`)
        return new Response("Orchestra Zen Browser Bridge Server", { status: 200, headers: this.getCorsHeaders(req) })
      },
      websocket: {
        open: (ws) => {
          this.lastSeen = Date.now()
          this.log("WebSocket client connected")
          if (this.activeWs && this.activeWs !== ws) {
            try {
              this.activeWs.close(1000, "Replaced by newer connection")
            } catch {}
          }
          this.activeWs = ws
        },
        message: (ws, raw) => {
          this.lastSeen = Date.now()
          this.handleMessage(ws, raw)
        },
        close: (ws, code, reason) => {
          this.log(`WebSocket client closed (code: ${code}, reason: ${reason || "none"})`)
          if (this.activeWs === ws) {
            this.activeWs = null
            if (Date.now() - this.lastSeen >= HEARTBEAT_TTL_MS) {
              this.clientInfo = undefined
              this.rejectPending("Zen Browser disconnected")
            }
          }
        },
      },
    })

    if (this.server.port !== undefined) {
      this.port = this.server.port
    }

    this.log(`Started listening on http://${this.hostname}:${this.port}`)
    return this
  }

  ensureStarted(port?: number): this {
    if (!this.server) {
      this.start(port)
    }
    return this
  }

  stop(): void {
    this.log("Stopping bridge server")
    this.rejectPending("Bridge server stopped")
    for (const poller of this.waitingPollers) {
      clearTimeout(poller.timer)
      poller.resolve(null)
    }
    this.waitingPollers = []
    this.pollQueue = []
    this.lastSeen = 0

    if (this.activeWs) {
      try {
        this.activeWs.close(1000, "Server stopped")
      } catch {}
      this.activeWs = null
    }
    this.clientInfo = undefined
    if (this.server) {
      try {
        this.server.stop(true)
      } catch {}
      this.server = null
    }
  }

  reset(): void {
    this.stop()
    this.nextId = 0
  }

  getStatus(): BridgeStatus {
    try {
      this.ensureStarted()
    } catch {
      return { connected: false, port: this.port }
    }

    const isWsConnected = this.activeWs !== null && this.activeWs.readyState === 1
    const isRecentHeartbeat = Date.now() - this.lastSeen < HEARTBEAT_TTL_MS
    const isConnected = isWsConnected || isRecentHeartbeat

    if (!isConnected) {
      return { connected: false, port: this.port }
    }

    return {
      connected: true,
      port: this.port,
      clientInfo: this.clientInfo ?? { client: "zen-extension", version: "1.0.0" },
    }
  }

  async sendRpc<T>(action: string, params?: unknown, timeoutMs = 10000): Promise<T> {
    this.ensureStarted()
    const status = this.getStatus()
    if (!status.connected) {
      throw new Error("Zen Browser extension is not connected")
    }

    const id = `rpc_${++this.nextId}_${Date.now()}`
    const rpcItem: RpcItem = { id, action, params: params ?? {} }
    this.log(`sendRpc action "${action}" with id "${id}"`)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        this.pollQueue = this.pollQueue.filter((item) => item.id !== id)
        this.warn(`RPC action "${action}" timed out after ${timeoutMs}ms (id: ${id})`)
        reject(new Error(`RPC action "${action}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      })

      if (this.activeWs && this.activeWs.readyState === 1) {
        try {
          this.activeWs.send(JSON.stringify(rpcItem))
          this.log(`Dispatched RPC id "${id}" via WebSocket`)
          return
        } catch {
          this.warn(`Failed to send RPC id "${id}" via WebSocket, falling back to HTTP queue`)
        }
      }

      this.dispatchOrEnqueuePoll(rpcItem)
    })
  }

  private async handleHeartbeat(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? "none"
    this.lastSeen = Date.now()
    let client = "zen-extension"
    let version = "1.0.0"

    try {
      const body = (await req.json()) as { client?: string; version?: string }
      if (body && typeof body === "object") {
        if (typeof body.client === "string") client = body.client
        if (typeof body.version === "string") version = body.version
        this.clientInfo = { client, version }
      }
    } catch {}

    this.log(`Heartbeat received from origin: ${origin} (client: ${client}, version: ${version})`)
    return Response.json({ ok: true, connected: true }, { status: 200, headers: this.getCorsHeaders(req) })
  }

  private async handlePoll(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? "none"
    this.lastSeen = Date.now()

    if (this.pollQueue.length > 0) {
      const item = this.pollQueue.shift()!
      this.log(`Poll fulfilled immediately for origin: ${origin} (action: ${item.action}, id: ${item.id})`)
      return Response.json(item, { status: 200, headers: this.getCorsHeaders(req) })
    }

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waitingPollers.findIndex((p) => p.timer === timer)
        if (idx !== -1) {
          this.waitingPollers.splice(idx, 1)
        }
        resolve(new Response(null, { status: 204, headers: this.getCorsHeaders(req) }))
      }, LONG_POLL_TIMEOUT_MS)

      this.waitingPollers.push({
        resolve: (item) => {
          clearTimeout(timer)
          if (item) {
            this.log(`Poll dispatched request to origin: ${origin} (action: ${item.action}, id: ${item.id})`)
            resolve(Response.json(item, { status: 200, headers: this.getCorsHeaders(req) }))
          } else {
            resolve(new Response(null, { status: 204, headers: this.getCorsHeaders(req) }))
          }
        },
        timer,
      })
    })
  }

  private async handleResult(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? "none"
    this.lastSeen = Date.now()

    let body: { id?: string | number; success?: boolean; result?: unknown; error?: string }
    try {
      body = (await req.json()) as typeof body
    } catch {
      this.warn(`Result parsing failed for origin: ${origin}`)
      return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: this.getCorsHeaders(req) })
    }

    if (!body || body.id === undefined) {
      this.warn(`Result missing id from origin: ${origin}`)
      return Response.json({ error: "Missing request id" }, { status: 400, headers: this.getCorsHeaders(req) })
    }

    const id = String(body.id)
    const pending = this.pendingRequests.get(id)
    if (!pending) {
      this.warn(`Result for unknown or expired request id: ${id} from origin: ${origin}`)
      return Response.json(
        { ok: false, error: "Request not found or expired" },
        { status: 404, headers: this.getCorsHeaders(req) },
      )
    }

    this.pendingRequests.delete(id)
    clearTimeout(pending.timer)
    this.pollQueue = this.pollQueue.filter((item) => item.id !== id)

    if (body.success === false || typeof body.error === "string") {
      const errorMsg = typeof body.error === "string" ? body.error : "RPC request failed"
      this.log(`Result error for id: ${id} from origin: ${origin}: ${errorMsg}`)
      pending.reject(new Error(errorMsg))
    } else {
      this.log(`Result success for id: ${id} from origin: ${origin}`)
      pending.resolve(body.result)
    }

    return Response.json({ ok: true }, { status: 200, headers: this.getCorsHeaders(req) })
  }

  private dispatchOrEnqueuePoll(item: RpcItem): void {
    if (this.waitingPollers.length > 0) {
      const poller = this.waitingPollers.shift()!
      this.log(`Dispatched RPC id "${item.id}" to waiting poller`)
      poller.resolve(item)
    } else {
      this.log(`Enqueued RPC id "${item.id}" to pollQueue (queue size: ${this.pollQueue.length + 1})`)
      this.pollQueue.push(item)
    }
  }

  private handleMessage(ws: ServerWebSocket<ClientData>, raw: string | ArrayBuffer | Uint8Array): void {
    let msg: Record<string, unknown>
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      msg = JSON.parse(text)
    } catch {
      this.warn("Failed to parse incoming WebSocket message as JSON")
      return
    }

    if (!msg || typeof msg !== "object") return

    if (msg.type === "hello") {
      this.clientInfo = {
        client: typeof msg.client === "string" ? msg.client : "zen-extension",
        version: typeof msg.version === "string" ? msg.version : "1.0.0",
      }
      this.log(`Handshake hello from WebSocket: client=${this.clientInfo.client}, version=${this.clientInfo.version}`)
      return
    }

    if ("id" in msg) {
      const id = String(msg.id)
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        clearTimeout(pending.timer)
        this.pollQueue = this.pollQueue.filter((item) => item.id !== id)
        if (msg.success === false || typeof msg.error === "string") {
          const errorMsg = typeof msg.error === "string" ? msg.error : "RPC request failed"
          this.log(`RPC error response over WebSocket for id: ${id}: ${errorMsg}`)
          pending.reject(new Error(errorMsg))
        } else {
          this.log(`RPC success response over WebSocket for id: ${id}`)
          pending.resolve(msg.result)
        }
      } else {
        this.warn(`WebSocket message received for unknown or expired id: ${id}`)
      }
    }
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingRequests.clear()
    this.pollQueue = []
  }
}

export const zenBridgeServer = new ZenBridgeServer()

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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  constructor(options?: { port?: number; hostname?: string }) {
    this.port = options?.port ?? DEFAULT_ZEN_BRIDGE_PORT
    this.hostname = options?.hostname ?? DEFAULT_ZEN_BRIDGE_HOST
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

        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS })
        }

        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upgraded = server.upgrade(req, {
            data: { id: crypto.randomUUID() },
          })
          if (upgraded) return undefined
          return new Response("WebSocket upgrade failed", { status: 400, headers: CORS_HEADERS })
        }

        if (method === "GET" && (url.pathname === "/status" || url.pathname === "/health")) {
          return Response.json(this.getStatus(), { headers: CORS_HEADERS })
        }

        if (method === "POST" && url.pathname === "/heartbeat") {
          return this.handleHeartbeat(req)
        }

        if (method === "GET" && url.pathname === "/poll") {
          return this.handlePoll()
        }

        if (method === "POST" && url.pathname === "/result") {
          return this.handleResult(req)
        }

        return new Response("Orchestra Zen Browser Bridge Server", { status: 200, headers: CORS_HEADERS })
      },
      websocket: {
        open: (ws) => {
          this.lastSeen = Date.now()
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
        close: (ws) => {
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

    return this
  }

  ensureStarted(port?: number): this {
    if (!this.server) {
      this.start(port)
    }
    return this
  }

  stop(): void {
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

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        this.pollQueue = this.pollQueue.filter((item) => item.id !== id)
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
          return
        } catch {
          // If WS send fails, fall through to HTTP polling queue
        }
      }

      this.dispatchOrEnqueuePoll(rpcItem)
    })
  }

  private async handleHeartbeat(req: Request): Promise<Response> {
    this.lastSeen = Date.now()
    try {
      const body = (await req.json()) as { client?: string; version?: string }
      if (body && typeof body === "object") {
        this.clientInfo = {
          client: typeof body.client === "string" ? body.client : "zen-extension",
          version: typeof body.version === "string" ? body.version : "1.0.0",
        }
      }
    } catch {}

    return Response.json({ ok: true, connected: true }, { status: 200, headers: CORS_HEADERS })
  }

  private async handlePoll(): Promise<Response> {
    this.lastSeen = Date.now()

    if (this.pollQueue.length > 0) {
      const item = this.pollQueue.shift()!
      return Response.json(item, { status: 200, headers: CORS_HEADERS })
    }

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waitingPollers.findIndex((p) => p.timer === timer)
        if (idx !== -1) {
          this.waitingPollers.splice(idx, 1)
        }
        resolve(new Response(null, { status: 204, headers: CORS_HEADERS }))
      }, LONG_POLL_TIMEOUT_MS)

      this.waitingPollers.push({
        resolve: (item) => {
          clearTimeout(timer)
          if (item) {
            resolve(Response.json(item, { status: 200, headers: CORS_HEADERS }))
          } else {
            resolve(new Response(null, { status: 204, headers: CORS_HEADERS }))
          }
        },
        timer,
      })
    })
  }

  private async handleResult(req: Request): Promise<Response> {
    this.lastSeen = Date.now()

    let body: { id?: string | number; success?: boolean; result?: unknown; error?: string }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS })
    }

    if (!body || body.id === undefined) {
      return Response.json({ error: "Missing request id" }, { status: 400, headers: CORS_HEADERS })
    }

    const id = String(body.id)
    const pending = this.pendingRequests.get(id)
    if (!pending) {
      return Response.json({ ok: false, error: "Request not found or expired" }, { status: 404, headers: CORS_HEADERS })
    }

    this.pendingRequests.delete(id)
    clearTimeout(pending.timer)
    this.pollQueue = this.pollQueue.filter((item) => item.id !== id)

    if (body.success === false || typeof body.error === "string") {
      pending.reject(new Error(typeof body.error === "string" ? body.error : "RPC request failed"))
    } else {
      pending.resolve(body.result)
    }

    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS })
  }

  private dispatchOrEnqueuePoll(item: RpcItem): void {
    if (this.waitingPollers.length > 0) {
      const poller = this.waitingPollers.shift()!
      poller.resolve(item)
    } else {
      this.pollQueue.push(item)
    }
  }

  private handleMessage(ws: ServerWebSocket<ClientData>, raw: string | ArrayBuffer | Uint8Array): void {
    let msg: Record<string, unknown>
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      msg = JSON.parse(text)
    } catch {
      return
    }

    if (!msg || typeof msg !== "object") return

    if (msg.type === "hello") {
      this.clientInfo = {
        client: typeof msg.client === "string" ? msg.client : "zen-extension",
        version: typeof msg.version === "string" ? msg.version : "1.0.0",
      }
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
          pending.reject(new Error(typeof msg.error === "string" ? msg.error : "RPC request failed"))
        } else {
          pending.resolve(msg.result)
        }
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

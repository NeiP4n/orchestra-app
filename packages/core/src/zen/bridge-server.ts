import type { Server, ServerWebSocket } from "bun"

export const DEFAULT_ZEN_BRIDGE_PORT = 4097
export const DEFAULT_ZEN_BRIDGE_HOST = "127.0.0.1"

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

export class ZenBridgeServer {
  private server: Server<ClientData> | null = null
  private activeWs: ServerWebSocket<ClientData> | null = null
  private clientInfo?: BridgeClientInfo
  private readonly pendingRequests = new Map<string, PendingRequest>()
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
      fetch: (req, server) => {
        const url = new URL(req.url)
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upgraded = server.upgrade(req, {
            data: { id: crypto.randomUUID() },
          })
          if (upgraded) return undefined
          return new Response("WebSocket upgrade failed", { status: 400 })
        }
        if (url.pathname === "/status" || url.pathname === "/health") {
          return Response.json(this.getStatus())
        }
        return new Response("Orchestra Zen Browser Bridge Server", { status: 200 })
      },
      websocket: {
        open: (ws) => {
          if (this.activeWs && this.activeWs !== ws) {
            try {
              this.activeWs.close(1000, "Replaced by newer connection")
            } catch {}
          }
          this.activeWs = ws
        },
        message: (ws, raw) => {
          this.handleMessage(ws, raw)
        },
        close: (ws) => {
          if (this.activeWs === ws) {
            this.activeWs = null
            this.clientInfo = undefined
            this.rejectPending("Zen Browser disconnected")
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

    const isConnected = this.activeWs !== null && this.activeWs.readyState === 1
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
    if (!this.activeWs || this.activeWs.readyState !== 1) {
      throw new Error("Zen Browser extension is not connected")
    }

    const id = `rpc_${++this.nextId}_${Date.now()}`
    const payload = JSON.stringify({ id, action, params: params ?? {} })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`RPC action "${action}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      })

      try {
        this.activeWs!.send(payload)
      } catch (error) {
        this.pendingRequests.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
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

    // Handshake
    if (msg.type === "hello") {
      this.clientInfo = {
        client: typeof msg.client === "string" ? msg.client : "zen-extension",
        version: typeof msg.version === "string" ? msg.version : "1.0.0",
      }
      return
    }

    // RPC Response
    if ("id" in msg) {
      const id = String(msg.id)
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        clearTimeout(pending.timer)
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
  }
}

export const zenBridgeServer = new ZenBridgeServer()

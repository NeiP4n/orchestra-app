/**
 * Loopback relay for WARP's own tunnel.
 *
 * Many users run a VPN client (Clash Verge, Happ, v2rayN, Hiddify, NekoBox…) in TUN mode, and in
 * several countries WARP's MASQUE tunnel is blocked outright. The VPN then either swallows warp-svc's
 * UDP (WARP says Connected, nothing passes) or sends it straight into the block. Both are fixed
 * without touching the VPN's rules: WARP is pointed at this relay with `warp-cli tunnel endpoint set
 * 127.0.0.1:<port>`, loopback is never captured by a TUN, and the relay carries the still end-to-end
 * encrypted MASQUE packets to Cloudflare through the VPN's local SOCKS5 port (or directly, from the
 * OpenCode process, which the VPN usually already routes).
 */
import { createSocket, type Socket as UdpSocket } from "node:dgram"
import { connect, createServer, type Server, type Socket } from "node:net"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const RELAY_PORT = 40002
export const RELAY_ENDPOINT = `127.0.0.1:${RELAY_PORT}`
/** Cloudflare's consumer MASQUE edge. Both HTTP/3 (UDP) and the HTTP/2 fallback (TCP) use port 443. */
const EDGE = { host: "162.159.198.1", port: 443 }
/** Local SOCKS5 ports of common VPN clients: v2rayN/Happ, Clash Verge Rev, Clash, NekoBox, Hiddify, generic. */
export const UPSTREAM_PORTS: readonly number[] = [10808, 7897, 7890, 7891, 2080, 12334, 1080, 20170]
const IDLE_MS = 120_000
const STATE_FILE = path.join(homedir(), ".opencode-warp-relay.json")

export type Upstream = { kind: "socks5"; host: string; port: number } | { kind: "direct" }

export function describeUpstream(upstream: Upstream) {
  return upstream.kind === "direct" ? "direct" : `socks5://${upstream.host}:${upstream.port}`
}

/** `ORCHESTRA_WARP_UPSTREAM=socks5://127.0.0.1:7897` or `direct` pins the upstream instead of probing. */
export function parseUpstream(value: string | undefined): Upstream | undefined {
  if (!value) return
  if (value.trim() === "direct") return { kind: "direct" }
  const match = /^socks5h?:\/\/([^:/]+):(\d{1,5})\/?$/i.exec(value.trim())
  if (!match) return
  return { kind: "socks5", host: match[1], port: Number(match[2]) }
}

// ---------- remembered upstream ----------

type State = { active: boolean; upstream: Upstream }

export function readState(): State | undefined {
  try {
    if (!existsSync(STATE_FILE)) return
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    const upstream = value?.upstream?.kind === "direct" ? { kind: "direct" as const } : parseUpstream(`socks5://${value?.upstream?.host}:${value?.upstream?.port}`)
    if (!upstream) return
    return { active: value.active === true, upstream }
  } catch {
    return
  }
}

export function writeState(state: State) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch {}
}

export function clearState() {
  rmSync(STATE_FILE, { force: true })
}

// ---------- upstream discovery ----------

/**
 * Candidate upstreams, best first: the pinned one, the one that worked last time, every local SOCKS5
 * port that grants UDP ASSOCIATE, then direct.
 */
export async function candidateUpstreams(env: NodeJS.ProcessEnv = process.env): Promise<Upstream[]> {
  const pinned = parseUpstream(env.ORCHESTRA_WARP_UPSTREAM)
  if (pinned) return [pinned]
  const remembered = readState()?.upstream
  const found = await Promise.all(UPSTREAM_PORTS.map(async (port) => ((await grantsUdp("127.0.0.1", port)) ? port : undefined)))
  const socks = found.filter((port): port is number => port !== undefined).map((port) => ({ kind: "socks5" as const, host: "127.0.0.1", port }))
  const all: Upstream[] = [...(remembered ? [remembered] : []), ...socks, { kind: "direct" }]
  return all.filter((item, index) => all.findIndex((other) => describeUpstream(other) === describeUpstream(item)) === index)
}

/** True when a SOCKS5 server without auth answers on the port and grants UDP ASSOCIATE. */
export function grantsUdp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let stage = 0
    const timer = setTimeout(() => done(false), 1_500)
    const done = (value: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.once("error", () => done(false))
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])))
    socket.on("data", (reply) => {
      if (stage === 0) {
        if (reply[0] !== 5 || reply[1] !== 0) return done(false)
        stage = 1
        socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }
      done(reply[0] === 5 && reply[1] === 0)
    })
  })
}

// ---------- relay ----------

let running: { upstream: Upstream; udp: UdpSocket; tcp: Server } | undefined

export function relayRunning() {
  return running?.upstream
}

/**
 * Listen on 127.0.0.1:RELAY_PORT (UDP for HTTP/3, TCP for the HTTP/2 fallback). A port already taken
 * means another OpenCode process runs the relay, which serves this one just as well.
 */
export async function startRelay(upstream: Upstream) {
  if (running && describeUpstream(running.upstream) === describeUpstream(upstream)) return
  stopRelay()
  const udp = createSocket("udp4")
  const tcp = createServer((client) => pipeTcp(client, upstream))
  const peers = new Map<string, Peer>()
  udp.on("message", (message, from) => {
    const key = `${from.address}:${from.port}`
    const peer = peers.get(key) ?? openPeer(upstream, (reply) => udp.send(reply, from.port, from.address), () => peers.delete(key))
    peers.set(key, peer)
    peer.send(message)
  })
  const udpBound = await bind((ready, fail) => {
    udp.once("error", fail)
    udp.bind(RELAY_PORT, "127.0.0.1", ready)
  })
  const tcpBound = await bind((ready, fail) => {
    tcp.once("error", fail)
    tcp.listen(RELAY_PORT, "127.0.0.1", ready)
  })
  if (!udpBound || !tcpBound) {
    udp.close()
    tcp.close()
    return
  }
  udp.on("error", () => undefined)
  tcp.on("error", () => undefined)
  udp.unref()
  tcp.unref()
  running = { upstream, udp, tcp }
}

export function stopRelay() {
  if (!running) return
  running.udp.close()
  running.tcp.close()
  running = undefined
}

function bind(start: (ready: () => void, fail: (error: Error) => void) => void) {
  return new Promise<boolean>((resolve) => start(() => resolve(true), () => resolve(false)))
}

type Peer = { send: (packet: Buffer) => void }

/** One UDP flow from warp-svc. Over SOCKS5 it holds its own UDP ASSOCIATE for as long as the flow lives. */
function openPeer(upstream: Upstream, reply: (packet: Buffer) => void, closed: () => void): Peer {
  const out = createSocket("udp4")
  let control: Socket | undefined
  let last = Date.now()
  const idle = setInterval(() => {
    if (Date.now() - last > IDLE_MS) close()
  }, 15_000)
  idle.unref()
  let closedOnce = false
  const close = () => {
    if (closedOnce) return
    closedOnce = true
    clearInterval(idle)
    out.close()
    control?.destroy()
    closed()
  }
  out.on("error", close)
  out.bind(0, "127.0.0.1")

  if (upstream.kind === "direct") {
    out.on("message", (packet) => reply(packet))
    return {
      send(packet) {
        last = Date.now()
        out.send(packet, EDGE.port, EDGE.host)
      },
    }
  }

  const header = Buffer.from([0, 0, 0, 1, ...EDGE.host.split(".").map(Number), EDGE.port >> 8, EDGE.port & 255])
  const queue: Buffer[] = []
  let relay: { host: string; port: number } | undefined
  out.on("message", (packet) => {
    const offset = udpHeaderLength(packet)
    if (offset) reply(packet.subarray(offset))
  })
  const socks = connect({ host: upstream.host, port: upstream.port }, () => socks.write(Buffer.from([5, 1, 0])))
  control = socks
  let stage = 0
  socks.on("data", (data) => {
    if (stage === 0) {
      if (data[1] !== 0) return close()
      stage = 1
      socks.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]))
      return
    }
    if (stage !== 1) return
    stage = 2
    if (data[1] !== 0 || data[3] !== 1) return close()
    const host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
    // Many servers answer 0.0.0.0, meaning "the address you reached me on".
    relay = { host: host === "0.0.0.0" ? upstream.host : host, port: data.readUInt16BE(8) }
    for (const packet of queue.splice(0)) out.send(Buffer.concat([header, packet]), relay.port, relay.host)
  })
  // The association ends with its control connection.
  socks.on("error", close)
  socks.on("close", close)
  return {
    send(packet) {
      last = Date.now()
      if (!relay) {
        if (queue.length < 64) queue.push(packet)
        return
      }
      out.send(Buffer.concat([header, packet]), relay.port, relay.host)
    },
  }
}

/** Length of the SOCKS5 UDP header (RSV RSV FRAG ATYP ADDR PORT); 0 for fragments and junk. */
export function udpHeaderLength(packet: Buffer) {
  if (packet.length < 4 || packet[2] !== 0) return 0
  if (packet[3] === 1) return 10
  if (packet[3] === 4) return 22
  if (packet[3] === 3) return 7 + (packet[4] ?? 0)
  return 0
}

function pipeTcp(client: Socket, upstream: Upstream) {
  if (upstream.kind === "direct") {
    const server = connect({ host: EDGE.host, port: EDGE.port }, () => {
      client.pipe(server)
      server.pipe(client)
    })
    server.on("error", () => client.destroy())
    client.on("error", () => server.destroy())
    return
  }
  const server = connect({ host: upstream.host, port: upstream.port }, () => server.write(Buffer.from([5, 1, 0])))
  server.on("error", () => client.destroy())
  client.on("error", () => server.destroy())
  let stage = 0
  const handshake = (data: Buffer) => {
    if (stage === 0) {
      if (data[1] !== 0) return client.destroy()
      stage = 1
      server.write(Buffer.from([5, 1, 0, 1, ...EDGE.host.split(".").map(Number), EDGE.port >> 8, EDGE.port & 255]))
      return
    }
    server.off("data", handshake)
    if (data[1] !== 0) return client.destroy()
    client.pipe(server)
    server.pipe(client)
  }
  server.on("data", handshake)
}

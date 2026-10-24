import { BoxRenderable, RGBA, type BoxOptions, type OptimizedBuffer, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/solid"
import { createMemo, createSignal, Show, splitProps, type JSX, type ParentProps } from "solid-js"
import type { ResolvedTheme } from "@orchestra/theme/tui"
import { useConfig } from "../config"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { hoverBackground } from "../ui/hover"
import { useNeuralActivity, type NeuralActivity, type NeuralSignal } from "./neural-activity"

// The neuron network that makes the interface feel alive. One native renderable paints four
// shapes straight into the frame buffer, so a moving impulse never re-runs Solid:
//   field  a mesh of nodes and links over an ordered-dither haze; impulses travel the links and a
//          node fires when one arrives, so activity spreads like a cascade. Each working Session
//          owns a hub neuron, and each tool it calls bridges the hub to that tool's neuron, which
//          shows the tool's name and then whether the call succeeded or failed
//   line   one row of synapse with impulses running along it, a living divider; tool names ride it
//   axon   the nerve beside a conversation
//   dot    one neuron that breathes, used as a status light
// `energy` (0..1) is a baseline from what is running; live activity from `NeuralActivity` adds to
// it every frame. The network's own clock runs at a tempo set by that energy: nearly frozen while
// the agents are silent, racing while they write and call tools.

export type NeuralPalette = Readonly<{
  signal: RGBA
  synapse: RGBA
  spark: RGBA
  dormant: RGBA
  done: RGBA
  fail: RGBA
}>
type Kind = "field" | "line" | "dot" | "axon"

// Themes written before the neural role existed keep a calm monochrome network. A finished tool
// call is outcome feedback, so it borrows the feedback colors.
export function neuralPalette(theme: ResolvedTheme): NeuralPalette {
  return {
    ...(theme.text.neural ?? {
      signal: theme.text.base,
      synapse: theme.border.base,
      spark: theme.text.base,
      dormant: theme.text.muted,
    }),
    done: theme.text.feedback.success.base,
    fail: theme.text.feedback.error.base,
  }
}

// How busy the agents are: a small floor for each running Session plus what they are doing now.
export function useNeuralEnergy() {
  const data = useData()
  const client = useClient()
  const activity = useNeuralActivity()
  return createMemo(() => {
    if (client.connection.status() !== "connected") return 0
    const running = data.session.list().filter((session) => data.session.status(session.id) === "running").length
    const floor = running > 0 ? 0.12 + running * 0.06 : 0.02
    return Math.min(1, floor + activity.pulse() * 0.88)
  })
}

// The network never stops moving while motion is on, so a test run (which waits for quiet frames)
// sees it still unless a test asks for it with ORCHESTRA_MOTION=1.
export function useMotion() {
  const config = useConfig().data
  const still =
    process.env.ORCHESTRA_NO_MOTION === "1" || (process.env.NODE_ENV === "test" && process.env.ORCHESTRA_MOTION !== "1")
  return () => (config.animations ?? true) && !still
}

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)
const MAX_PULSES = 96
const RIPPLE_SECONDS = 0.9
const BRIDGE_FADE_MS = 1800
const MAX_BRIDGES = 8
// Ordered dithering: a 4x4 Bayer matrix turns a smooth haze into a stable pixel pattern.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16)
const DITHER_GLYPHS = ["░", "░", "▒", "▒"]
const DITHER_LEVELS = [0.1, 0.16, 0.24, 0.34]

type NeuralCanvasOptions = BoxOptions & {
  kind?: Kind
  palette?: NeuralPalette
  backdrop?: RGBA
  energy?: number
  enabled?: boolean
  seed?: number
  stimulus?: number
  activity?: NeuralActivity
  session?: string
}

type Cells = readonly (readonly [number, number])[]
type Tone = "signal" | "spark" | "dormant"
type Node = { x: number; y: number; flash: number; edges: number[]; tone: Tone }
type Edge = { a: number; b: number; cells: Cells; weight: number }
type Impulse = { edge: number; at: number; dir: 1 | -1; speed: number; tone: Tone; hops: number }
// A tool call drawn as a temporary link from the Session's hub to the tool's neuron.
type Bridge = {
  call: string | undefined
  label: string
  from: number
  to: number
  cells: Cells
  at: number
  state: "travel" | "wait" | "done" | "fail"
  // When the impulse reached the tool's neuron, and when the call reported how it ended.
  reached: number
  settled: number
}
type Rider = { call: string | undefined; label: string; at: number; state: "wait" | "done" | "fail"; settled: number }

export class NeuralCanvasRenderable extends BoxRenderable {
  private _kind: Kind
  private _palette: NeuralPalette | undefined
  private _backdrop: RGBA
  private _energy: number
  private _enabled: boolean
  private _seed: number
  private _activity: NeuralActivity | undefined
  private _session: string | undefined
  // `time` is the network's own clock, slowed or sped by the tempo; `clock` is wall time for
  // fades that must read the same at any tempo, such as a tool's label.
  private time = 0
  private clock = 0
  private energyNow = 0
  private cursor = 0
  private spawn = 0
  private nodes: Node[] = []
  private edges: Edge[] = []
  private impulses: Impulse[] = []
  private builtFor = ""
  private ripples: { x: number; y: number; age: number }[] = []
  private touched = 0
  private hubs = new Map<string, number>()
  private toolNodes = new Map<string, number>()
  private bridges: Bridge[] = []
  private riders: Rider[] = []
  private glitches: { y: number; height: number; shift: number; life: number }[] = []
  private scans: number[] = []
  private glitchSpawn = 0
  private warmth = new Float32Array(0)
  private ramps: { cool: RGBA[]; warm: RGBA[]; key: unknown[] } | undefined
  private signalFlash = 0
  private signalTone: keyof NeuralPalette = "signal"
  // The axon's message-to-message impulse: where it is, where the newest message ends, and the
  // glow it leaves on arrival.
  private travel: { at: number; to: number } | undefined
  private arrival = 0
  private lastHeight = 0

  constructor(ctx: RenderContext, options: NeuralCanvasOptions) {
    super(ctx, options)
    this._kind = options.kind ?? "field"
    this._palette = options.palette
    this._backdrop = options.backdrop ?? RGBA.defaultBackground()
    this._energy = options.energy ?? 0.2
    this._enabled = options.enabled ?? true
    this._seed = options.seed ?? 7
    this._activity = options.activity
    this._session = options.session
    this.cursor = this._activity?.cursor ?? 0
    this.live = this._enabled
    // The field answers the pointer: passing over it excites the nearest neuron, a click sends a wave.
    this.onMouseMove = (event) => {
      if (this._kind !== "field" || !this._enabled || this.clock - this.touched < 90) return
      this.touched = this.clock
      this.poke(event.x - this.screenX, event.y - this.screenY, false)
    }
    this.onMouseDown = (event) => {
      if (this._kind !== "field" || !this._enabled) return
      this.poke(event.x - this.screenX, event.y - this.screenY, true)
    }
  }

  // Each change of the stimulus (a keystroke, a sent message) fires a neuron somewhere in the mesh.
  set stimulus(value: number) {
    if (!value || this._kind !== "field" || !this._enabled || this.nodes.length === 0) return
    const node = this.nodes[Math.floor(Math.random() * this.nodes.length)]!
    this.poke(node.x, node.y, false)
  }

  set kind(value: Kind) {
    this._kind = value
    this.builtFor = ""
    this.requestRender()
  }
  set palette(value: NeuralPalette | undefined) {
    this._palette = value
    this.requestRender()
  }
  set backdrop(value: RGBA) {
    this._backdrop = value
    this.requestRender()
  }
  set energy(value: number) {
    this._energy = Math.max(0, Math.min(1, value))
  }
  set enabled(value: boolean) {
    if (value === this._enabled) return
    this._enabled = value
    this.live = value
    this.requestRender()
  }
  set seed(value: number) {
    this._seed = value
    this.builtFor = ""
  }
  set activity(value: NeuralActivity | undefined) {
    this._activity = value
    this.cursor = value?.cursor ?? 0
  }
  set session(value: string | undefined) {
    this._session = value
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0) {
    super.renderSelf(buffer)
    const palette = this._palette
    if (!palette || this.width <= 0 || this.height <= 0) return
    // A long pause (hidden tab, a slow frame) must not fast-forward the network in one jump.
    const dt = this._enabled ? Math.min(deltaTime, 100) : 0
    // The baseline raised by live activity, eased so a burst swells and a silence settles.
    const target = Math.min(1, Math.max(this._energy * 0.6, this._activity?.level(this._session) ?? 0))
    this.energyNow += (target - this.energyNow) * Math.min(1, dt / (target > this.energyNow ? 180 : 900))
    // Silence nearly freezes the network; a busy agent makes it race.
    const tempo = 0.08 + 1.9 * Math.pow(this.energyNow, 1.2)
    const scaled = dt * tempo
    this.time += scaled
    this.clock += dt
    const signals = this.takeSignals()
    if (this._kind === "dot") return this.paintDot(buffer, palette, signals, dt)
    if (this._kind === "line") return this.paintLine(buffer, palette, signals, dt)
    if (this._kind === "axon") return this.paintAxon(buffer, palette, signals, scaled)
    this.build()
    signals.forEach((signal) => this.react(signal))
    this.step(scaled, dt)
    this.paintField(buffer, palette)
  }

  private takeSignals() {
    if (!this._activity || !this._enabled) return []
    const signals = this._activity.since(this.cursor)
    this.cursor = this._activity.cursor
    if (!this._session) return signals
    return signals.filter((signal) => signal.sessionID === this._session)
  }

  private cell(buffer: OptimizedBuffer, x: number, y: number, char: string, fg: RGBA) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    buffer.setCellWithAlphaBlending(this.screenX + x, this.screenY + y, char, fg, TRANSPARENT)
  }

  // Text sits on the backdrop so a label stays readable over the mesh and the haze.
  private text(buffer: OptimizedBuffer, x: number, y: number, value: string, fg: RGBA) {
    Array.from(value).forEach((char, index) => {
      const column = x + index
      if (column < 0 || y < 0 || column >= this.width || y >= this.height) return
      buffer.setCellWithAlphaBlending(this.screenX + column, this.screenY + y, char, fg, this._backdrop)
    })
  }

  private glow(from: RGBA, to: RGBA, amount: number) {
    return tint(from, to, Math.max(0, Math.min(1, amount)))
  }

  // A status light: it breathes faster as the agents work and flashes the color of each action.
  private paintDot(buffer: OptimizedBuffer, palette: NeuralPalette, signals: readonly NeuralSignal[], dt: number) {
    signals.forEach((signal) => {
      this.signalFlash = 1
      this.signalTone =
        signal.kind === "fail" ? "fail" : signal.kind === "done" ? "done" : signal.kind === "tool" ? "spark" : "signal"
    })
    this.signalFlash = Math.max(0, this.signalFlash - dt / 600)
    const breath = this._enabled ? 0.5 + 0.5 * Math.sin(this.time / 420) : 1
    const base = this.glow(palette.synapse, palette.signal, 0.35 + breath * 0.65)
    const fg = this.signalFlash > 0 ? this.glow(base, palette[this.signalTone], this.signalFlash) : base
    this.cell(buffer, 0, 0, this.signalFlash > 0.5 ? "◉" : breath > 0.82 ? "◉" : "●", fg)
  }

  // A synapse row: dim links, a node every few cells, and impulses that light the nodes they pass.
  // A called tool's name rides the row as its own impulse and takes the color of how it ended.
  private paintLine(buffer: OptimizedBuffer, palette: NeuralPalette, signals: readonly NeuralSignal[], dt: number) {
    const width = this.width
    const energy = this.energyNow
    signals.forEach((signal) => {
      if (signal.kind === "tool" && signal.label) {
        this.riders.push({ call: signal.call, label: signal.label, at: 0, state: "wait", settled: 0 })
        if (this.riders.length > 4) this.riders.shift()
        return
      }
      if (signal.kind !== "done" && signal.kind !== "fail") return
      const rider = this.riders.find((item) => item.call === signal.call && item.state === "wait")
      if (!rider) return
      rider.state = signal.kind
      rider.settled = this.clock
    })
    const span = width + 8
    const count = Math.max(1, Math.round(width / (46 - energy * 30)))
    const heads = Array.from({ length: count }, (_, index) => {
      const offset = (index * span) / count + (index % 2) * 5
      return ((this.time / 1000) * 22 + offset) % span
    })
    for (let x = 0; x < width; x++) {
      const node = (x + this._seed) % 9 === 0
      const near = heads.reduce((best, head) => {
        const distance = head - x
        return distance >= 0 && distance < best ? distance : best
      }, Infinity)
      const lit = near === Infinity ? 0 : Math.max(0, 1 - near / 7)
      if (near < 0.8) {
        this.cell(buffer, x, 0, "━", palette.signal)
        continue
      }
      if (node) {
        this.cell(buffer, x, 0, lit > 0.3 ? "◆" : "◇", this.glow(palette.synapse, palette.spark, lit * 1.4))
        continue
      }
      this.cell(buffer, x, 0, lit > 0.15 ? "─" : "╌", this.glow(palette.synapse, palette.signal, lit))
    }
    this.riders = this.riders.filter((rider) => {
      const label = ` ${rider.state === "done" ? "✓" : rider.state === "fail" ? "✗" : "▸"} ${rider.label} `
      rider.at += (dt / 1000) * (14 + energy * 20)
      const fade = rider.state === "wait" ? 0 : (this.clock - rider.settled) / BRIDGE_FADE_MS
      if (rider.at - label.length > width || fade >= 1) return false
      const color = rider.state === "wait" ? palette.spark : palette[rider.state]
      this.text(buffer, Math.round(rider.at) - label.length, 0, label, this.glow(color, palette.synapse, fade))
      return true
    })
  }

  // A vertical nerve down the conversation: impulses run from each message to the next. Only the
  // rows on screen are painted, so a long transcript costs no more than a short one.
  private paintAxon(buffer: OptimizedBuffer, palette: NeuralPalette, signals: readonly NeuralSignal[], dt: number) {
    // The transcript grew: an impulse leaves the end of the previous message and runs down to the
    // new one. While an answer streams the impulse keeps chasing its growing end.
    if (this.lastHeight > 0 && this.height > this.lastHeight) {
      this.travel = { at: this.travel?.at ?? Math.max(0, this.lastHeight - 6), to: this.height - 1 }
    }
    this.lastHeight = this.height
    // A tool call or its ending lights the newest message's end in that action's color.
    signals.forEach((signal) => {
      if (signal.kind === "write" || signal.kind === "think") return
      this.arrival = 1
      this.signalTone = signal.kind === "fail" ? "fail" : signal.kind === "done" ? "done" : "spark"
    })
    if (this.travel && dt > 0) {
      this.travel.at += (dt / 1000) * (28 + (this.travel.to - this.travel.at) * 2)
      if (this.travel.at >= this.travel.to) {
        this.travel = undefined
        this.arrival = 1
        this.signalTone = "spark"
      }
    }
    this.arrival = Math.max(0, this.arrival - (dt / 1000) * 1.1)
    const spacing = 12
    const offset = ((this.time / 1000) * 20) % spacing
    const first = Math.max(0, -this.screenY)
    const last = Math.min(this.height, buffer.height - this.screenY)
    const rest = this.glow(this._backdrop, palette.synapse, 0.85)
    for (let y = first; y < last; y++) {
      const chase = this.travel ? this.travel.at - y : -1
      if (chase >= 0 && chase < 8) {
        this.cell(buffer, 0, y, chase < 1 ? "┃" : "│", this.glow(palette.signal, palette.spark, 1 - chase / 8))
        continue
      }
      // The newest message's end glows for a moment after the impulse lands on it.
      const tail = this.height - 1 - y
      if (this.arrival > 0 && tail >= 0 && tail < 4) {
        this.cell(buffer, 0, y, "┃", this.glow(rest, palette[this.signalTone], this.arrival * (1 - tail / 4)))
        continue
      }
      // How far this row sits behind the nearest impulse travelling down.
      const behind = (((offset - y) % spacing) + spacing) % spacing
      if (!this._enabled || behind > 3.5) {
        this.cell(buffer, 0, y, "│", rest)
        continue
      }
      if (behind < 1) {
        this.cell(buffer, 0, y, "┃", palette.signal)
        continue
      }
      this.cell(buffer, 0, y, "│", this.glow(rest, palette.signal, 1 - behind / 4))
    }
  }

  // Nodes are scattered by a seeded generator so the same terminal size always draws the same mesh.
  private build() {
    const key = `${this.width}x${this.height}:${this._seed}`
    if (key === this.builtFor) return
    this.builtFor = key
    this.impulses = []
    this.bridges = []
    this.hubs.clear()
    this.toolNodes.clear()
    this.warmth = new Float32Array(this.width * this.height)
    const random = mulberry32(this._seed * 9973 + this.width * 31 + this.height)
    const count = Math.max(4, Math.min(80, Math.round((this.width * this.height) / 44)))
    this.nodes = Array.from({ length: count }, () => ({
      x: Math.floor(random() * this.width),
      y: Math.floor(random() * this.height),
      flash: random() * 0.4,
      edges: [],
      tone: "signal" as Tone,
    }))
    // Cells are about twice as tall as wide, so horizontal distance counts half.
    const distance = (a: Node, b: Node) => Math.hypot((a.x - b.x) / 2, a.y - b.y)
    const seen = new Set<string>()
    this.edges = []
    const connect = (from: number, to: number) => {
      const pair = [from, to].sort((left, right) => left - right).join(":")
      if (seen.has(pair)) return
      seen.add(pair)
      this.nodes[from]!.edges.push(this.edges.length)
      this.nodes[to]!.edges.push(this.edges.length)
      this.edges.push({ a: from, b: to, cells: line(this.nodes[from]!, this.nodes[to]!), weight: 0 })
    }
    this.nodes.forEach((node, index) => {
      const ranked = this.nodes
        .map((other, target) => ({ target, d: distance(node, other) }))
        .filter((item) => item.target !== index)
        .sort((left, right) => left.d - right.d)
      // Three short links make a dense mesh; now and then a long one ties distant regions together.
      ranked
        .filter((item) => item.d < 14)
        .slice(0, 3)
        .forEach((item) => connect(index, item.target))
      const far = ranked.find((item) => item.d >= 14 && item.d < 30)
      if (far && random() < 0.18) connect(index, far.target)
    })
  }

  // A Session's hub is a well-connected neuron that its actions start from; it keeps the same
  // neuron for as long as the mesh lives.
  private hub(sessionID: string) {
    const known = this.hubs.get(sessionID)
    if (known !== undefined) return known
    const taken = new Set(this.hubs.values())
    const candidates = this.nodes
      .map((node, index) => ({ index, degree: node.edges.length }))
      .filter((item) => !taken.has(item.index))
      .sort((left, right) => right.degree - left.degree)
      .slice(0, 6)
    const pick = candidates[hash(sessionID) % Math.max(1, candidates.length)]?.index ?? 0
    this.hubs.set(sessionID, pick)
    return pick
  }

  // Every tool owns one neuron, so the same tool always lights the same place in the mesh.
  private toolNode(name: string, avoid: number) {
    const known = this.toolNodes.get(name)
    if (known !== undefined) return known
    const hubs = new Set(this.hubs.values())
    const free = this.nodes.map((_, index) => index).filter((index) => index !== avoid && !hubs.has(index))
    const pick = free[hash(name) % Math.max(1, free.length)] ?? avoid
    this.toolNodes.set(name, pick)
    return pick
  }

  // Turn one action of the agents into something visible in the field.
  private react(signal: NeuralSignal) {
    if (this.nodes.length === 0) return
    const hub = this.hub(signal.sessionID)
    const node = this.nodes[hub]!
    if (signal.kind === "write") {
      node.flash = Math.max(node.flash, 0.7)
      node.tone = "signal"
      const edge = node.edges[Math.floor(Math.random() * node.edges.length)]
      if (edge !== undefined) this.fire(edge, this.edges[edge]!.a === hub ? 1 : -1, 1, "signal")
      return
    }
    if (signal.kind === "think") {
      node.flash = Math.max(node.flash, 0.5)
      node.tone = "dormant"
      const edge = node.edges[Math.floor(Math.random() * node.edges.length)]
      if (edge !== undefined) this.fire(edge, this.edges[edge]!.a === hub ? 1 : -1, 2, "dormant")
      return
    }
    if (signal.kind === "tool") {
      node.flash = 1
      node.tone = "spark"
      const to = this.toolNode(signal.label ?? "tool", hub)
      this.bridges.push({
        call: signal.call,
        label: signal.label ?? "tool",
        from: hub,
        to,
        cells: line(node, this.nodes[to]!),
        at: 0,
        state: "travel",
        reached: 0,
        settled: 0,
      })
      if (this.bridges.length > MAX_BRIDGES) this.bridges.shift()
      return
    }
    if (signal.kind === "done" || signal.kind === "fail") {
      const bridge = this.bridges.find(
        (item) => item.call === signal.call && (item.state === "travel" || item.state === "wait"),
      )
      if (!bridge) return
      bridge.state = signal.kind
      bridge.settled = this.clock
      this.nodes[bridge.to]!.flash = 1
      this.nodes[bridge.to]!.tone = "spark"
      return
    }
    if (signal.kind === "step" || signal.kind === "compact") {
      // A new step sweeps a scan line down the haze, the camelAI-style refresh of the screen.
      this.scans.push(-2)
      node.flash = 1
      return
    }
    // A prompt lands on the hub as a wave.
    this.poke(node.x, node.y, true)
  }

  private step(dt: number, real: number) {
    if (real <= 0 || this.edges.length === 0) return
    const seconds = dt / 1000
    const wall = real / 1000
    this.nodes.forEach((node) => (node.flash = Math.max(0, node.flash - wall * 1.4)))
    this.edges.forEach((edge) => (edge.weight = Math.max(0, edge.weight - wall * 0.12)))
    this.ripples = this.ripples.filter((ripple) => (ripple.age += wall) < RIPPLE_SECONDS)
    this.scans = this.scans.map((y) => y + wall * 34).filter((y) => y < this.height + 3)
    this.glitches = this.glitches.filter((glitch) => (glitch.life -= wall) > 0)
    // Horizontal tearing, more often the busier the network.
    this.glitchSpawn += wall * (0.05 + this.energyNow * 1.6)
    while (this.glitchSpawn >= 1) {
      this.glitchSpawn -= 1
      this.glitches.push({
        y: Math.floor(Math.random() * this.height),
        height: 1 + Math.floor(Math.random() * 3),
        shift: Math.round((Math.random() - 0.5) * 16),
        life: 0.08 + Math.random() * 0.22,
      })
    }
    // Background firing: on the network's own clock, so a quiet network barely stirs.
    this.spawn += seconds * (0.8 + this.energyNow * 9)
    while (this.spawn >= 1) {
      this.spawn -= 1
      const edge = Math.floor(Math.random() * this.edges.length)
      this.fire(edge, Math.random() < 0.5 ? 1 : -1, 0, Math.random() < 0.18 ? "spark" : "signal")
    }
    this.bridges = this.bridges.filter((bridge) => {
      if (bridge.state === "travel") {
        bridge.at += wall * (22 + this.energyNow * 30)
        if (bridge.at >= bridge.cells.length) {
          bridge.state = "wait"
          bridge.reached = this.clock
          this.nodes[bridge.to]!.flash = 1
          this.nodes[bridge.to]!.tone = "spark"
        }
      }
      if (bridge.state === "travel") return true
      // A call that never reports back still leaves the field eventually.
      if (bridge.state === "wait") return this.clock - bridge.reached < 30000
      return this.clock - bridge.settled < BRIDGE_FADE_MS
    })
    const arrived: Impulse[] = []
    this.impulses = this.impulses.filter((impulse) => {
      const length = this.edges[impulse.edge]!.cells.length
      impulse.at += impulse.dir * impulse.speed * seconds
      if (impulse.at >= 0 && impulse.at <= length - 1) return true
      arrived.push(impulse)
      return false
    })
    arrived.forEach((impulse) => {
      const edge = this.edges[impulse.edge]!
      // Links that carry impulses grow stronger, so the paths the agents use stand out.
      edge.weight = Math.min(1, edge.weight + 0.22)
      const target = impulse.dir === 1 ? edge.b : edge.a
      const node = this.nodes[target]!
      node.flash = 1
      node.tone = impulse.tone
      // The node passes the impulse on, less often the further it has come: a cascade that dies out.
      const onward = node.edges.filter((index) => index !== impulse.edge)
      if (onward.length === 0 || Math.random() > 0.72 - impulse.hops * 0.12 + this.energyNow * 0.2) return
      const next = onward[Math.floor(Math.random() * onward.length)]!
      this.fire(next, this.edges[next]!.a === target ? 1 : -1, impulse.hops + 1, impulse.tone)
    })
  }

  // Excite the neuron nearest to a cell: it flashes and fires down every link; a strong poke
  // also sends a ring across the field and wakes the neurons the ring passes.
  private poke(x: number, y: number, strong: boolean) {
    if (this.nodes.length === 0) return
    const nearest = this.nodes.reduce(
      (best, node, index) => {
        const d = Math.hypot((node.x - x) / 2, node.y - y)
        return d < best.d ? { index, d } : best
      },
      { index: 0, d: Infinity },
    )
    const node = this.nodes[nearest.index]!
    node.flash = 1
    node.edges.forEach((edge) =>
      this.fire(edge, this.edges[edge]!.a === nearest.index ? 1 : -1, strong ? 0 : 1, "signal"),
    )
    if (!strong) return
    this.ripples.push({ x, y, age: 0 })
    this.nodes.forEach((other) => {
      const d = Math.hypot((other.x - x) / 2, other.y - y)
      if (d < 9) other.flash = Math.max(other.flash, 1 - d / 9)
    })
  }

  private fire(edge: number, dir: 1 | -1, hops: number, tone: Tone) {
    if (this.impulses.length >= MAX_PULSES) return
    const length = this.edges[edge]!.cells.length
    this.impulses.push({
      edge,
      dir,
      at: dir === 1 ? 0 : length - 1,
      speed: 9 + Math.random() * 6 + this.energyNow * 18,
      tone,
      hops,
    })
  }

  // Dither colors are cached per palette and backdrop: the haze paints thousands of cells a frame.
  private ditherRamps(palette: NeuralPalette) {
    const key = [palette, this._backdrop]
    if (this.ramps && this.ramps.key.every((value, index) => value === key[index])) return this.ramps
    this.ramps = {
      key,
      cool: DITHER_LEVELS.map((level) => tint(this._backdrop, palette.dormant, level)),
      warm: DITHER_LEVELS.map((level) => tint(this._backdrop, palette.signal, level * 1.35)),
    }
    return this.ramps
  }

  // A drifting haze of value noise, stretched sideways and quantized through the Bayer matrix:
  // it brightens with energy, blooms around firing neurons, tears on glitches and lights under scans.
  private paintHaze(buffer: OptimizedBuffer, palette: NeuralPalette) {
    const width = this.width
    const height = this.height
    const energy = this.energyNow
    const ramps = this.ditherRamps(palette)
    const drift = this.time / 1000
    const lift = -0.12 + energy * 0.28
    this.warmth.fill(0)
    this.nodes.forEach((node) => {
      if (node.flash < 0.2) return
      const radius = 2 + Math.round(node.flash * 3)
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius * 2; dx <= radius * 2; dx++) {
          const x = node.x + dx
          const y = node.y + dy
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          const falloff = 1 - Math.hypot(dx / 2, dy) / (radius + 0.5)
          if (falloff > 0) this.warmth[y * width + x] += falloff * node.flash * 0.55
        }
      }
    })
    for (let y = 0; y < height; y++) {
      const glitch = this.glitches.find((item) => y >= item.y && y < item.y + item.height)
      const scan = this.scans.reduce((best, row) => Math.max(best, 1 - Math.abs(row - y) / 2), 0)
      const shift = glitch ? glitch.shift : 0
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        const noise = fbm((x + shift) * 0.06 + drift * 0.9, y * 0.21 + Math.sin(drift * 0.3) * 0.6, this._seed)
        const warm = this.warmth[index]! + scan * 0.45 + (glitch ? 0.12 : 0)
        const value = (noise - 0.5) * 1.1 + lift + warm
        const quantized = value * 4
        const level = Math.min(
          4,
          Math.floor(quantized) + (quantized - Math.floor(quantized) > BAYER[(y % 4) * 4 + (x % 4)]! ? 1 : 0),
        )
        if (level <= 0) continue
        const ramp = warm > 0.15 ? ramps.warm : ramps.cool
        this.cell(buffer, x, y, DITHER_GLYPHS[level - 1]!, ramp[level - 1]!)
      }
    }
  }

  private paintField(buffer: OptimizedBuffer, palette: NeuralPalette) {
    this.paintHaze(buffer, palette)
    const rest = this.glow(this._backdrop, palette.synapse, 0.9)
    this.edges.forEach((edge, index) => {
      const breath = this._enabled ? 0.55 + 0.45 * Math.sin(this.time / 1700 + index * 0.9) : 0.8
      const fg = this.glow(this.glow(this._backdrop, rest, breath), palette.signal, edge.weight * 0.6)
      const glyph = edge.weight > 0.55 ? "∙" : "·"
      edge.cells.forEach(([x, y]) => this.cell(buffer, x, y, glyph, fg))
    })
    // A tool call's bridge: a dashed link that an impulse crosses, then holds the outcome's color.
    this.bridges.forEach((bridge) => {
      const fade =
        bridge.state === "travel" || bridge.state === "wait" ? 0 : (this.clock - bridge.settled) / BRIDGE_FADE_MS
      const color = bridge.state === "done" || bridge.state === "fail" ? palette[bridge.state] : palette.spark
      const link = this.glow(this.glow(this._backdrop, color, 0.55), this._backdrop, fade)
      bridge.cells.forEach(([x, y], index) => {
        if (bridge.state === "travel" && index > bridge.at) return
        this.cell(buffer, x, y, index % 2 === 0 ? "╌" : "·", link)
      })
      if (bridge.state !== "travel") return
      const head = bridge.cells[Math.floor(bridge.at)]
      if (head) this.cell(buffer, head[0], head[1], "◆", palette.spark)
    })
    this.impulses.forEach((impulse) => {
      const cells = this.edges[impulse.edge]!.cells
      const head = Math.round(impulse.at)
      const color = palette[impulse.tone]
      for (let trail = 3; trail >= 1; trail--) {
        const cell = cells[head - impulse.dir * trail]
        if (cell) this.cell(buffer, cell[0], cell[1], "∙", this.glow(palette.synapse, color, 1 - trail / 4))
      }
      const cell = cells[head]
      if (cell) this.cell(buffer, cell[0], cell[1], "•", color)
    })
    // A ring grows from a click, twice as wide as tall to look round in terminal cells, fading as it goes.
    this.ripples.forEach((ripple) => {
      const radius = 2 + ripple.age * 22
      const fade = 1 - ripple.age / RIPPLE_SECONDS
      const steps = Math.max(12, Math.round(radius * 5))
      for (let step = 0; step < steps; step++) {
        const angle = (step / steps) * Math.PI * 2
        this.cell(
          buffer,
          Math.round(ripple.x + Math.cos(angle) * radius * 2),
          Math.round(ripple.y + Math.sin(angle) * radius),
          fade > 0.5 ? "∘" : "·",
          this.glow(this._backdrop, palette.signal, fade),
        )
      }
    })
    const hubs = new Set(this.hubs.values())
    const base = this.glow(palette.dormant, palette.signal, 0.28 + this.energyNow * 0.2)
    this.nodes.forEach((node, index) => {
      const lit = palette[node.tone]
      const fg = node.flash > 0.6 ? this.glow(lit, palette.spark, node.flash - 0.6) : this.glow(base, lit, node.flash)
      const glyph = hubs.has(index) ? "◈" : node.flash > 0.45 ? "◉" : node.edges.length > 3 ? "●" : "•"
      this.cell(buffer, node.x, node.y, glyph, fg)
    })
    // The tool's name sits beside its neuron: `▸` while it runs, then `✓` or `✗` as it fades.
    this.bridges.forEach((bridge) => {
      if (bridge.state === "travel") return
      const node = this.nodes[bridge.to]!
      const fade = bridge.state === "wait" ? 0 : (this.clock - bridge.settled) / BRIDGE_FADE_MS
      const label = `${bridge.state === "done" ? "✓" : bridge.state === "fail" ? "✗" : "▸"} ${bridge.label}`
      const color = bridge.state === "wait" ? palette.signal : palette[bridge.state]
      const x = node.x + 2 + label.length <= this.width ? node.x + 2 : node.x - 1 - label.length
      this.text(buffer, x, node.y, label, this.glow(color, this._backdrop, fade))
    })
  }
}

extend({ neural_canvas: NeuralCanvasRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    neural_canvas: typeof NeuralCanvasRenderable
  }
}

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function hash(value: string) {
  return Array.from(value).reduce((state, char) => Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261)
}

// Smooth value noise in 0..1 from a lattice of seeded random corners.
function noise(x: number, y: number, seed: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const top = lattice(ix, iy, seed) + (lattice(ix + 1, iy, seed) - lattice(ix, iy, seed)) * sx
  const bottom = lattice(ix, iy + 1, seed) + (lattice(ix + 1, iy + 1, seed) - lattice(ix, iy + 1, seed)) * sx
  return top + (bottom - top) * sy
}

function lattice(x: number, y: number, seed: number) {
  const value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)
  const mixed = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296
}

function fbm(x: number, y: number, seed: number) {
  return noise(x, y, seed) * 0.65 + noise(x * 2.3, y * 2.3, seed + 17) * 0.35
}

// The cells between two nodes, ends excluded so the nodes keep their own glyphs.
function line(from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
  return Array.from({ length: Math.max(0, steps - 1) }, (_, index) => {
    const t = (index + 1) / steps
    return [Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t)] as const
  })
}

type CanvasLayout = {
  position?: "absolute" | "relative"
  left?: number
  right?: number
  top?: number
  bottom?: number
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`
  zIndex?: number
  flexGrow?: number
  flexShrink?: number
}

// A mesh of neurons filling its box, meant to sit behind content.
export function NeuronField(
  props: CanvasLayout & { energy?: number; seed?: number; backdrop?: RGBA; stimulus?: number },
) {
  const theme = useTheme()
  const motion = useMotion()
  const activity = useNeuralActivity()
  const [own, layout] = splitProps(props, ["energy", "seed", "backdrop", "stimulus"])
  return (
    <neural_canvas
      {...layout}
      kind="field"
      activity={activity}
      palette={neuralPalette(theme)}
      backdrop={own.backdrop ?? theme.background.base}
      energy={own.energy ?? 0.2}
      seed={own.seed ?? 7}
      stimulus={own.stimulus ?? 0}
      enabled={motion()}
    />
  )
}

// The nerve beside a conversation. It runs only while the agent works and for a moment after a
// message lands, so an idle transcript costs nothing to keep on screen.
export function NeuralAxon(props: { active: boolean; energy?: number; session?: string }) {
  const theme = useTheme()
  const motion = useMotion()
  const activity = useNeuralActivity()
  return (
    <neural_canvas
      kind="axon"
      activity={activity}
      session={props.session}
      position="absolute"
      left={1}
      top={0}
      width={1}
      height="100%"
      zIndex={0}
      palette={neuralPalette(theme)}
      backdrop={theme.background.base}
      energy={props.energy ?? 0.5}
      enabled={motion() && props.active}
    />
  )
}

// One row of living synapse, a divider that shows the network working. Given a Session, it
// follows only that Session's actions.
export function NeuralLine(props: {
  energy?: number
  seed?: number
  width?: number | `${number}%`
  session?: string
  backdrop?: RGBA
}) {
  const theme = useTheme()
  const motion = useMotion()
  const activity = useNeuralActivity()
  return (
    <neural_canvas
      kind="line"
      activity={activity}
      session={props.session}
      backdrop={props.backdrop ?? theme.background.base}
      height={1}
      width={props.width ?? "100%"}
      flexShrink={0}
      palette={neuralPalette(theme)}
      energy={props.energy ?? 0.2}
      seed={props.seed ?? 3}
      enabled={motion()}
    />
  )
}

// A single breathing neuron, a status light that flashes with each action of the agents.
export function NeuronDot(props: { energy?: number; session?: string }) {
  const theme = useTheme()
  const motion = useMotion()
  const activity = useNeuralActivity()
  return (
    <neural_canvas
      kind="dot"
      activity={activity}
      session={props.session}
      width={1}
      height={1}
      flexShrink={0}
      palette={neuralPalette(theme)}
      energy={props.energy ?? 0.3}
      enabled={motion()}
    />
  )
}

// A rounded card: a soft border that lights up under the pointer, a title set into the border.
export function NeuralCard(
  props: ParentProps<{
    title?: string
    footer?: string
    onClick?: () => void
    active?: boolean
    padding?: number
    gap?: number
    flexGrow?: number
    flexShrink?: number
    width?: number | `${number}%`
    minHeight?: number
    id?: string
  }>,
) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const palette = () => neuralPalette(theme)
  const border = () =>
    props.active ? palette().signal : hovered() ? tint(theme.border.base, palette().signal, 0.7) : theme.border.base
  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={border()}
      title={props.title ? ` ${props.title} ` : undefined}
      titleColor={props.active || hovered() ? palette().signal : theme.text.muted}
      bottomTitle={props.footer ? ` ${props.footer} ` : undefined}
      bottomTitleAlignment="right"
      paddingLeft={props.padding ?? 1}
      paddingRight={props.padding ?? 1}
      gap={props.gap}
      flexShrink={props.flexShrink ?? 0}
      flexGrow={props.flexGrow}
      width={props.width}
      minHeight={props.minHeight}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={props.onClick}
    >
      {props.children}
    </box>
  )
}

// A pill-shaped action: quiet at rest, filled on hover, lit when active.
export function NeuralChip(props: {
  label: string
  icon?: string
  onClick: () => void
  active?: boolean
  accent?: boolean
  id?: string
  hint?: string
}) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const palette = () => neuralPalette(theme)
  const fg = () =>
    props.active
      ? theme.text.action.primary.focused
      : hovered()
        ? theme.text.base
        : props.accent
          ? palette().signal
          : theme.text.muted
  return (
    <box
      id={props.id}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        props.active ? theme.background.action.primary.focused : hovered() ? hoverBackground(theme) : undefined
      }
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => {
        event.stopPropagation()
        props.onClick()
      }}
    >
      <Show when={props.icon}>
        <text fg={props.active ? fg() : hovered() ? palette().signal : palette().synapse} wrapMode="none">
          {`${props.icon} `}
        </text>
      </Show>
      <text fg={fg()} wrapMode="none">
        {props.label}
      </text>
      <Show when={props.hint && hovered()}>
        <text fg={theme.text.muted} wrapMode="none">
          {` ${props.hint}`}
        </text>
      </Show>
    </box>
  )
}

// A tree connector in the synapse color: `├─`, `└─`, `│ `.
export function Branch(props: { last?: boolean; through?: boolean; lit?: boolean; children?: JSX.Element }) {
  const theme = useTheme()
  const palette = () => neuralPalette(theme)
  return (
    <text flexShrink={0} fg={props.lit ? palette().signal : palette().synapse} wrapMode="none">
      {props.through ? "│ " : props.last ? "╰─" : "├─"}
    </text>
  )
}

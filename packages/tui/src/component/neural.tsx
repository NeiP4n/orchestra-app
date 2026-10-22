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

// The neuron network that makes the interface feel alive. One native renderable paints three
// shapes straight into the frame buffer, so a moving impulse never re-runs Solid:
//   field  a mesh of nodes and links; impulses travel the links, a node fires when one arrives
//          and may pass it on, so activity spreads like a cascade
//   line   one row of synapse with impulses running along it, used as a living divider
//   dot    one neuron that breathes, used as a status light
// `energy` (0..1) is how busy the agents are: more and faster impulses, brighter nodes.

export type NeuralPalette = Readonly<{ signal: RGBA; synapse: RGBA; spark: RGBA; dormant: RGBA }>
type Kind = "field" | "line" | "dot"

// Themes written before the neural role existed keep a calm monochrome network.
export function neuralPalette(theme: ResolvedTheme): NeuralPalette {
  return (
    theme.text.neural ?? {
      signal: theme.text.base,
      synapse: theme.border.base,
      spark: theme.text.base,
      dormant: theme.text.muted,
    }
  )
}

// How busy the agents are, from the sessions running right now.
export function useNeuralEnergy() {
  const data = useData()
  const client = useClient()
  return createMemo(() => {
    if (client.connection.status() !== "connected") return 0
    const running = data.session.list().filter((session) => data.session.status(session.id) === "running").length
    return Math.min(1, 0.12 + running * 0.3)
  })
}

export function useMotion() {
  const config = useConfig().data
  return () => (config.animations ?? true) && process.env.ORCHESTRA_NO_MOTION !== "1"
}

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)
const MAX_PULSES = 48

type NeuralCanvasOptions = BoxOptions & {
  kind?: Kind
  palette?: NeuralPalette
  backdrop?: RGBA
  energy?: number
  enabled?: boolean
  seed?: number
}

type Node = { x: number; y: number; flash: number; edges: number[] }
type Edge = { a: number; b: number; cells: readonly (readonly [number, number])[] }
type Impulse = { edge: number; at: number; dir: 1 | -1; speed: number; spark: boolean; hops: number }

export class NeuralCanvasRenderable extends BoxRenderable {
  private _kind: Kind
  private _palette: NeuralPalette | undefined
  private _backdrop: RGBA
  private _energy: number
  private _enabled: boolean
  private _seed: number
  private time = 0
  private spawn = 0
  private nodes: Node[] = []
  private edges: Edge[] = []
  private impulses: Impulse[] = []
  private builtFor = ""

  constructor(ctx: RenderContext, options: NeuralCanvasOptions) {
    super(ctx, options)
    this._kind = options.kind ?? "field"
    this._palette = options.palette
    this._backdrop = options.backdrop ?? RGBA.defaultBackground()
    this._energy = options.energy ?? 0.2
    this._enabled = options.enabled ?? true
    this._seed = options.seed ?? 7
    this.live = this._enabled
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

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0) {
    super.renderSelf(buffer)
    const palette = this._palette
    if (!palette || this.width <= 0 || this.height <= 0) return
    // A long pause (hidden tab, a slow frame) must not fast-forward the network in one jump.
    const dt = this._enabled ? Math.min(deltaTime, 100) : 0
    this.time += dt
    if (this._kind === "dot") return this.paintDot(buffer, palette)
    if (this._kind === "line") return this.paintLine(buffer, palette)
    this.build()
    this.step(dt)
    this.paintField(buffer, palette)
  }

  private cell(buffer: OptimizedBuffer, x: number, y: number, char: string, fg: RGBA) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    buffer.setCellWithAlphaBlending(this.screenX + x, this.screenY + y, char, fg, TRANSPARENT)
  }

  private glow(from: RGBA, to: RGBA, amount: number) {
    return tint(from, to, Math.max(0, Math.min(1, amount)))
  }

  private paintDot(buffer: OptimizedBuffer, palette: NeuralPalette) {
    const breath = this._enabled ? 0.5 + 0.5 * Math.sin(this.time / (900 - this._energy * 500)) : 1
    this.cell(buffer, 0, 0, breath > 0.82 ? "◉" : "●", this.glow(palette.synapse, palette.signal, 0.35 + breath * 0.65))
  }

  // A synapse row: dim links, a node every few cells, and impulses that light the nodes they pass.
  private paintLine(buffer: OptimizedBuffer, palette: NeuralPalette) {
    const width = this.width
    const speed = 10 + this._energy * 34
    const count = Math.max(1, Math.round(width / (46 - this._energy * 26)))
    const span = width + 8
    const heads = Array.from({ length: count }, (_, index) => {
      const offset = (index * span) / count + (index % 2) * 5
      return ((this.time / 1000) * speed + offset) % span
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
  }

  // Nodes are scattered by a seeded generator so the same terminal size always draws the same mesh.
  private build() {
    const key = `${this.width}x${this.height}:${this._seed}`
    if (key === this.builtFor) return
    this.builtFor = key
    this.impulses = []
    const random = mulberry32(this._seed * 9973 + this.width * 31 + this.height)
    const count = Math.max(4, Math.min(64, Math.round((this.width * this.height) / 52)))
    this.nodes = Array.from({ length: count }, () => ({
      x: Math.floor(random() * this.width),
      y: Math.floor(random() * this.height),
      flash: random() * 0.4,
      edges: [],
    }))
    // Cells are about twice as tall as wide, so horizontal distance counts half.
    const distance = (a: Node, b: Node) => Math.hypot((a.x - b.x) / 2, a.y - b.y)
    const seen = new Set<string>()
    this.edges = []
    this.nodes.forEach((node, index) => {
      const nearest = this.nodes
        .map((other, target) => ({ target, d: distance(node, other) }))
        .filter((item) => item.target !== index && item.d < 14)
        .sort((left, right) => left.d - right.d)
        .slice(0, 2)
      nearest.forEach((item) => {
        const pair = [index, item.target].sort((left, right) => left - right).join(":")
        if (seen.has(pair)) return
        seen.add(pair)
        const edge = { a: index, b: item.target, cells: line(node, this.nodes[item.target]!) }
        this.nodes[index]!.edges.push(this.edges.length)
        this.nodes[item.target]!.edges.push(this.edges.length)
        this.edges.push(edge)
      })
    })
  }

  private step(dt: number) {
    if (dt <= 0 || this.edges.length === 0) return
    const seconds = dt / 1000
    this.nodes.forEach((node) => (node.flash = Math.max(0, node.flash - seconds * 1.6)))
    // Background firing: a few impulses a second at rest, a storm while agents work.
    this.spawn += seconds * (0.8 + this._energy * 9)
    while (this.spawn >= 1) {
      this.spawn -= 1
      const edge = Math.floor(Math.random() * this.edges.length)
      this.fire(edge, Math.random() < 0.5 ? 1 : -1, 0)
    }
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
      const target = impulse.dir === 1 ? edge.b : edge.a
      const node = this.nodes[target]!
      node.flash = 1
      // The node passes the impulse on, less often the further it has come: a cascade that dies out.
      const onward = node.edges.filter((index) => index !== impulse.edge)
      if (onward.length === 0 || Math.random() > 0.72 - impulse.hops * 0.12 + this._energy * 0.2) return
      const next = onward[Math.floor(Math.random() * onward.length)]!
      this.fire(next, this.edges[next]!.a === target ? 1 : -1, impulse.hops + 1)
    })
  }

  private fire(edge: number, dir: 1 | -1, hops: number) {
    if (this.impulses.length >= MAX_PULSES) return
    const length = this.edges[edge]!.cells.length
    this.impulses.push({
      edge,
      dir,
      at: dir === 1 ? 0 : length - 1,
      speed: 9 + Math.random() * 6 + this._energy * 18,
      spark: Math.random() < 0.18,
      hops,
    })
  }

  private paintField(buffer: OptimizedBuffer, palette: NeuralPalette) {
    const rest = this.glow(this._backdrop, palette.synapse, 0.9)
    this.edges.forEach((edge, index) => {
      const breath = this._enabled ? 0.55 + 0.45 * Math.sin(this.time / 1700 + index * 0.9) : 0.8
      const fg = this.glow(this._backdrop, rest, breath)
      edge.cells.forEach(([x, y]) => this.cell(buffer, x, y, "·", fg))
    })
    this.impulses.forEach((impulse) => {
      const cells = this.edges[impulse.edge]!.cells
      const head = Math.round(impulse.at)
      const color = impulse.spark ? palette.spark : palette.signal
      for (let trail = 3; trail >= 1; trail--) {
        const cell = cells[head - impulse.dir * trail]
        if (cell) this.cell(buffer, cell[0], cell[1], "∙", this.glow(palette.synapse, color, 1 - trail / 4))
      }
      const cell = cells[head]
      if (cell) this.cell(buffer, cell[0], cell[1], "•", color)
    })
    this.nodes.forEach((node) => {
      const base = this.glow(palette.dormant, palette.signal, 0.28 + this._energy * 0.2)
      const fg = node.flash > 0.6 ? this.glow(palette.signal, palette.spark, node.flash - 0.6) : this.glow(base, palette.signal, node.flash)
      this.cell(buffer, node.x, node.y, node.flash > 0.45 ? "◉" : node.edges.length > 2 ? "●" : "•", fg)
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

// The cells between two nodes, ends excluded so the nodes keep their own glyphs.
function line(from: Node, to: Node) {
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
export function NeuronField(props: CanvasLayout & { energy?: number; seed?: number; backdrop?: RGBA }) {
  const theme = useTheme()
  const motion = useMotion()
  const [own, layout] = splitProps(props, ["energy", "seed", "backdrop"])
  return (
    <neural_canvas
      {...layout}
      kind="field"
      palette={neuralPalette(theme)}
      backdrop={own.backdrop ?? theme.background.base}
      energy={own.energy ?? 0.2}
      seed={own.seed ?? 7}
      enabled={motion()}
    />
  )
}

// One row of living synapse, a divider that shows the network working.
export function NeuralLine(props: { energy?: number; seed?: number; width?: number | `${number}%` }) {
  const theme = useTheme()
  const motion = useMotion()
  return (
    <neural_canvas
      kind="line"
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

// A single breathing neuron, a status light.
export function NeuronDot(props: { energy?: number }) {
  const theme = useTheme()
  const motion = useMotion()
  return (
    <neural_canvas
      kind="dot"
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

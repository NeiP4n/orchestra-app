import { createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { getSharedNeuralActivity, type NeuralSignalKind } from "./neural-activity"

export { getSharedNeuralActivity, neuralEnergyFloor, type NeuralSignal, type NeuralSignalKind } from "./neural-activity"
import "./neural-field.css"

// The neuron network on the web, ported from the TUI
// (packages/tui/src/component/neural.tsx): one canvas per shape, drawing
// straight from NeuralActivity every animation frame, so a moving impulse
// never re-runs Solid:
//   field  a mesh of nodes and links; impulses travel the links and a node
//          fires when one arrives, so activity spreads like a cascade
//   line   one row of synapses with impulses running along it, a living divider
//   axon   the nerve beside a conversation; impulses flow down it
//   dot    one neuron that breathes, used as a status light
// The network's own clock runs at a tempo set by the energy: nearly frozen
// while the agents are silent, racing while they write and call tools.
// The loop pauses when the canvas is off-screen or the tab is hidden, and
// draws a single static frame when motion is off.

// Motion is one source of truth: the app setting (settings.appearance
// animations) mirrored onto <html data-motion>. The OS reduced-motion
// preference is the default before the app chooses.
export function useMotion(): () => boolean {
  const [motion, setMotion] = createSignal(readMotion())
  onMount(() => {
    const observer = new MutationObserver(() => setMotion(readMotion()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] })
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onMedia = () => setMotion(readMotion())
    media.addEventListener("change", onMedia)
    onCleanup(() => {
      observer.disconnect()
      media.removeEventListener("change", onMedia)
    })
  })
  return motion
}

function readMotion(): boolean {
  if (typeof document === "undefined") return true
  const attr = document.documentElement.dataset.motion
  if (attr === "on") return true
  if (attr === "off") return false
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

type Palette = {
  signal: string
  synapse: string
  spark: string
  dormant: string
  done: string
  fail: string
}

function readPalette(el: HTMLElement): Palette {
  const style = getComputedStyle(el)
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    signal: get("--v2-text-text-base", "#eeeeee"),
    synapse: get("--v2-border-border-base", "#808080"),
    spark: get("--icon-spark-base", "#67e8f9"),
    dormant: get("--v2-text-text-muted", "#808080"),
    done: get("--v2-state-fg-success", "#7fd88f"),
    fail: get("--v2-state-fg-danger", "#e06c75"),
  }
}

function colorFor(kind: NeuralSignalKind, palette: Palette): string {
  switch (kind) {
    case "done":
      return palette.done
    case "fail":
      return palette.fail
    case "tool":
    case "step":
    case "prompt":
    case "compact":
    case "ask":
    case "answer":
    case "select":
      return palette.spark
    default:
      return palette.signal
  }
}

// Deterministic pseudo-random, so the node layout is stable across mounts.
function mulberry32(seed: number) {
  let value = seed
  return () => {
    value |= 0
    value = (value + 0x6d2b79f5) | 0
    let result = Math.imul(value ^ (value >>> 15), 1 | value)
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

type Node = { x: number; y: number; flash: number }
type Pulse = { from: number; to: number; t: number; color: string }

function buildNodes(count: number, seed: number): Node[] {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () => ({ x: 0.06 + random() * 0.88, y: 0.08 + random() * 0.84, flash: 0 }))
}

function buildLinks(nodes: readonly Node[], maxDistance: number): Array<[number, number]> {
  const links: Array<[number, number]> = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x
      const dy = nodes[i].y - nodes[j].y
      if (Math.hypot(dx, dy) < maxDistance) links.push([i, j])
    }
  }
  return links
}

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, width: number, height: number, dt: number) => void) {
  const motion = useMotion()
  let canvas: HTMLCanvasElement | undefined
  let raf = 0
  let last = 0
  let visible = true

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    if (!canvas || !visible || document.hidden) {
      last = now
      return
    }
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016)
    last = now
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    draw(ctx, rect.width, rect.height, dt)
  }

  const drawStatic = () => {
    if (!canvas) return
    const ctx = fitCanvas(canvas)
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    draw(ctx, rect.width, rect.height, 0)
  }

  onMount(() => {
    if (!canvas) return
    fitCanvas(canvas)
    const resize = new ResizeObserver(() => {
      fitCanvas(canvas)
      if (!motion()) drawStatic()
    })
    resize.observe(canvas)
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible) last = performance.now()
    })
    io.observe(canvas)
    onCleanup(() => {
      resize.disconnect()
      io.disconnect()
    })
  })

  createEffect(() => {
    if (motion()) {
      last = performance.now()
      raf = requestAnimationFrame(tick)
      onCleanup(() => cancelAnimationFrame(raf))
      return
    }
    cancelAnimationFrame(raf)
    drawStatic()
  })

  return (el: HTMLCanvasElement) => {
    canvas = el
  }
}

function spawnPulses(
  activity: ReturnType<typeof getSharedNeuralActivity>,
  cursor: { value: number },
  nodes: readonly Node[],
  links: ReadonlyArray<readonly [number, number]>,
  palette: Palette,
  pulses: Pulse[],
  maxPulses: number,
) {
  const signals = activity.since(cursor.value)
  cursor.value = activity.cursor
  for (const signal of signals) {
    if (links.length === 0) break
    const link = links[Math.floor(Math.random() * links.length)]
    pulses.push({ from: link[0], to: link[1], t: 0, color: colorFor(signal.kind, palette) })
    if (pulses.length > maxPulses) pulses.shift()
  }
}

export const NeuralField: Component<{ sessionIDs?: readonly string[]; class?: string }> = (props) => {
  const activity = getSharedNeuralActivity()
  const nodes = buildNodes(24, 42)
  const links = buildLinks(nodes, 0.3)
  const pulses: Pulse[] = []
  const cursor = { value: activity.cursor }
  let palette: Palette | undefined

  const ref = useCanvasLoop((ctx, width, height, dt) => {
    const canvas = ctx.canvas as HTMLCanvasElement
    palette ??= readPalette(canvas)
    const energy = activity.level(props.sessionIDs)
    const tempo = 0.25 + energy * 1.5
    spawnPulses(activity, cursor, nodes, links, palette, pulses, 96)

    ctx.clearRect(0, 0, width, height)
    const scale = Math.min(width, height)
    const px = (x: number) => x * width
    const py = (y: number) => y * height

    ctx.lineWidth = 1
    for (const [a, b] of links) {
      ctx.strokeStyle = palette.synapse
      ctx.globalAlpha = 0.12 + energy * 0.18
      ctx.beginPath()
      ctx.moveTo(px(nodes[a].x), py(nodes[a].y))
      ctx.lineTo(px(nodes[b].x), py(nodes[b].y))
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    for (const pulse of pulses) {
      pulse.t += (dt * tempo) / 0.9
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i]
      if (pulse.t >= 1) {
        nodes[pulse.to].flash = 1
        pulses.splice(i, 1)
        continue
      }
      const from = nodes[pulse.from]
      const to = nodes[pulse.to]
      const x = px(from.x + (to.x - from.x) * pulse.t)
      const y = py(from.y + (to.y - from.y) * pulse.t)
      ctx.fillStyle = pulse.color
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(x, y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    for (const node of nodes) {
      node.flash = Math.max(0, node.flash - dt * 0.6)
      const radius = 1.5 + node.flash * 2.5 + energy * 0.5
      ctx.fillStyle = node.flash > 0.05 ? palette.signal : palette.dormant
      ctx.globalAlpha = 0.5 + node.flash * 0.5 + energy * 0.2
      ctx.beginPath()
      ctx.arc(px(node.x), py(node.y), Math.min(radius, scale * 0.02), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  })

  return <canvas ref={ref} data-component="neural-field" class={props.class} aria-hidden="true" />
}

export const NeuralLine: Component<{ sessionIDs?: readonly string[]; class?: string }> = (props) => {
  const activity = getSharedNeuralActivity()
  const nodes = buildNodes(16, 7).map((node, index) => ({ ...node, x: (index + 0.5) / 16, y: 0.5 }))
  const links = nodes.slice(0, -1).map((_, index) => [index, index + 1] as [number, number])
  const pulses: Pulse[] = []
  const cursor = { value: activity.cursor }
  let palette: Palette | undefined
  let label: { text: string; until: number } | undefined

  const ref = useCanvasLoop((ctx, width, height, dt) => {
    const canvas = ctx.canvas as HTMLCanvasElement
    palette ??= readPalette(canvas)
    const energy = activity.level(props.sessionIDs)
    const tempo = 0.25 + energy * 1.5
    spawnPulses(activity, cursor, nodes, links, palette, pulses, 32)
    const latest = activity.latest
    if (latest) label = { text: latest, until: performance.now() + 1800 }

    ctx.clearRect(0, 0, width, height)
    const midY = height / 2
    ctx.strokeStyle = palette.synapse
    ctx.globalAlpha = 0.25 + energy * 0.25
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(width, midY)
    ctx.stroke()
    ctx.globalAlpha = 1

    for (const node of nodes) {
      ctx.fillStyle = palette.dormant
      ctx.globalAlpha = 0.6 + energy * 0.3
      ctx.beginPath()
      ctx.arc(node.x * width, midY, 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i]
      pulse.t += (dt * tempo) / 0.9
      if (pulse.t >= 1) {
        pulses.splice(i, 1)
        continue
      }
      const from = nodes[pulse.from]
      const to = nodes[pulse.to]
      const x = (from.x + (to.x - from.x) * pulse.t) * width
      ctx.fillStyle = pulse.color
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(x, midY, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    if (label && performance.now() < label.until) {
      ctx.fillStyle = palette.signal
      ctx.globalAlpha = Math.min(1, (label.until - performance.now()) / 900)
      ctx.font = "12px system-ui, sans-serif"
      ctx.textAlign = "center"
      ctx.fillText(label.text, width / 2, Math.max(12, midY - 10))
      ctx.globalAlpha = 1
    }
  })

  return <canvas ref={ref} data-component="neural-line" class={props.class} aria-hidden="true" />
}

export const NeuralAxon: Component<{ sessionIDs?: readonly string[]; class?: string }> = (props) => {
  const activity = getSharedNeuralActivity()
  const nodes = buildNodes(12, 11).map((node, index) => ({ ...node, x: 0.5, y: (index + 0.5) / 12 }))
  const links = nodes.slice(0, -1).map((_, index) => [index, index + 1] as [number, number])
  const pulses: Pulse[] = []
  const cursor = { value: activity.cursor }
  let palette: Palette | undefined

  const ref = useCanvasLoop((ctx, width, height, dt) => {
    const canvas = ctx.canvas as HTMLCanvasElement
    palette ??= readPalette(canvas)
    const energy = activity.level(props.sessionIDs)
    const tempo = 0.25 + energy * 1.5
    spawnPulses(activity, cursor, nodes, links, palette, pulses, 32)

    ctx.clearRect(0, 0, width, height)
    const midX = width / 2
    ctx.strokeStyle = palette.synapse
    ctx.globalAlpha = 0.25 + energy * 0.25
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(midX, 0)
    ctx.lineTo(midX, height)
    ctx.stroke()
    ctx.globalAlpha = 1

    for (const node of nodes) {
      node.flash = Math.max(0, node.flash - dt * 0.6)
      ctx.fillStyle = node.flash > 0.05 ? palette.signal : palette.dormant
      ctx.globalAlpha = 0.6 + node.flash * 0.4 + energy * 0.2
      ctx.beginPath()
      ctx.arc(midX, node.y * height, 1.5 + node.flash * 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i]
      pulse.t += (dt * tempo) / 0.9
      if (pulse.t >= 1) {
        nodes[pulse.to].flash = 1
        pulses.splice(i, 1)
        continue
      }
      const from = nodes[pulse.from]
      const to = nodes[pulse.to]
      const y = (from.y + (to.y - from.y) * pulse.t) * height
      ctx.fillStyle = pulse.color
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(midX, y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  })

  return <canvas ref={ref} data-component="neural-axon" class={props.class} aria-hidden="true" />
}

export const NeuralDot: Component<{ sessionIDs?: readonly string[]; class?: string }> = (props) => {
  const activity = getSharedNeuralActivity()
  let palette: Palette | undefined

  const ref = useCanvasLoop((ctx, width, height, dt) => {
    const canvas = ctx.canvas as HTMLCanvasElement
    palette ??= readPalette(canvas)
    const energy = activity.level(props.sessionIDs)
    const now = performance.now() / 1000
    const breathe = 0.5 + 0.5 * Math.sin(now * (0.8 + energy * 2.4))

    ctx.clearRect(0, 0, width, height)
    const cx = width / 2
    const cy = height / 2
    const radius = Math.min(width, height) / 2 - 1

    ctx.strokeStyle = palette.synapse
    ctx.globalAlpha = 0.3 + energy * 0.3
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, radius * (0.55 + breathe * 0.25), 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = palette.spark
    ctx.globalAlpha = 0.55 + energy * 0.35 + breathe * 0.1
    ctx.beginPath()
    ctx.arc(cx, cy, 2 + energy * 1.5 + breathe * 0.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    void dt
  })

  return <canvas ref={ref} data-component="neural-dot" class={props.class} aria-hidden="true" />
}

// Resonance rings: the sculk spinner. Three rings expand from the center
// dot and fade, one after another. When motion is off the rings hide and
// only the dot stays (see neural-field.css).
export const SculkSpinner: Component<{ class?: string }> = (props) => {
  return (
    <span
      data-component="sculk-spinner"
      role="status"
      aria-label="Loading"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <span data-slot="sculk-spinner-ring" />
      <span data-slot="sculk-spinner-ring" />
      <span data-slot="sculk-spinner-ring" />
      <span data-slot="sculk-spinner-dot" />
    </span>
  )
}

import { createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { getSharedNeuralActivity, type NeuralSignalKind } from "./neural-activity"
import { NeuralMeshActivity } from "./neural-mesh-activity"
import { buildNeuralMesh, type MeshNode } from "./neural-mesh"
import { createNeuralHazePainter } from "./neural-haze"
import { createNeuralFrameLoop } from "./neural-frame-loop"

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
    signal: get("--v2-neural-signal", get("--v2-text-text-base", "#eeeeee")),
    synapse: get("--v2-neural-synapse", get("--v2-border-border-base", "#808080")),
    spark: get("--v2-neural-spark", get("--icon-spark-base", "#67e8f9")),
    dormant: get("--v2-neural-dormant", get("--v2-text-text-muted", "#808080")),
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

type Pulse = { from: number; to: number; t: number; color: string; hops?: number }

function buildNodes(count: number, seed: number): Node[] {
  const random = mulberry32(seed)

  return Array.from({ length: count }, () => ({ x: 0.06 + random() * 0.88, y: 0.08 + random() * 0.84, flash: 0 }))
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

function useCanvasLoop(
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number, dt: number, palette: Palette) => void,
) {
  const motion = useMotion()
  let canvas: HTMLCanvasElement | undefined
  let visible = false
  let palette: Palette | undefined

  const loop = createNeuralFrameLoop({
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
    draw: (dt) => {
      if (!canvas) return
      const ctx = canvas.getContext("2d")

      if (!ctx) return
      const rect = canvas.getBoundingClientRect()
      palette ??= readPalette(canvas)
      draw(ctx, rect.width, rect.height, dt, palette)
    },
  })

  const sync = () => loop.update({ motion: motion(), visible, hidden: document.hidden })

  onMount(() => {
    const el = canvas

    if (!el) return
    fitCanvas(el)

    const resize = new ResizeObserver(() => {
      fitCanvas(el)
      loop.redraw()
    })

    resize.observe(el)

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      sync()
    })

    io.observe(el)

    const refreshPalette = () => {
      palette = undefined
      loop.redraw()
    }

    const theme = new MutationObserver(refreshPalette)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-scheme", "style", "class"],
    })
    const scheme = window.matchMedia("(prefers-color-scheme: dark)")
    scheme.addEventListener("change", refreshPalette)
    document.addEventListener("visibilitychange", sync)
    onCleanup(() => {
      resize.disconnect()
      io.disconnect()
      theme.disconnect()
      scheme.removeEventListener("change", refreshPalette)
      document.removeEventListener("visibilitychange", sync)
      loop.dispose()
    })
  })

  createEffect(sync)

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

export const NeuralField: Component<{ sessionIDs?: readonly string[]; class?: string; variant?: "overview" }> = (
  props,
) => {
  const activity = getSharedNeuralActivity()
  const paintHaze = createNeuralHazePainter()
  let drift = 0
  let mesh = buildNeuralMesh(1, 1)
  let meshKey = ""
  let nodes: MeshNode[] = []
  let signals = new NeuralMeshActivity(nodes)
  let links: Array<[number, number]> = []
  const pulses: Pulse[] = []
  let background = 0
  const cursor = { value: activity.cursor }

  const ref = useCanvasLoop((ctx, width, height, dt, palette) => {
    const cols = Math.max(1, Math.floor(width / 8))
    const rows = Math.max(1, Math.floor(height / 16))
    const key = `${cols}x${rows}`

    if (key !== meshKey) {
      mesh = buildNeuralMesh(cols, rows)
      nodes = mesh.nodes.map((node) => ({ ...node, x: node.x / cols, y: node.y / rows }))
      signals = new NeuralMeshActivity(nodes)
      links = mesh.edges.map((edge): [number, number] => [edge.from, edge.to])
      pulses.length = 0
      meshKey = key
    }

    const energy = activity.level(props.sessionIDs)
    const tempo = 0.25 + energy * 1.5
    const fresh = activity.since(cursor.value)
    cursor.value = activity.cursor

    for (const signal of fresh) {
      if (props.sessionIDs && !props.sessionIDs.includes(signal.sessionID)) continue
      const event = signals.take(signal)
      const outgoing = links.filter((edge) => edge.includes(event.hub))
      const selected = event.all ? outgoing : outgoing.slice(0, 1)

      for (const [a, b] of selected) {
        pulses.push({ from: event.hub, to: a === event.hub ? b : a, t: 0, color: colorFor(event.kind, palette) })
      }

      if (pulses.length > 96) pulses.splice(0, pulses.length - 96)
    }
    signals.step(dt, energy, cols, rows)
    background += dt * tempo * (0.8 + energy * 9)

    while (background >= 1 && links.length) {
      background -= 1
      const [a, b] = links[Math.floor(Math.random() * links.length)]
      const reverse = Math.random() < 0.5
      pulses.push({
        from: reverse ? b : a,
        to: reverse ? a : b,
        t: 0,
        hops: 0,
        color: Math.random() < 0.18 ? palette.spark : palette.signal,
      })
    }

    if (pulses.length > 96) pulses.splice(0, pulses.length - 96)

    ctx.clearRect(0, 0, width, height)
    drift += dt * tempo
    paintHaze(ctx, width, height, drift, energy, palette, nodes, signals)
    const px = (x: number) => x * width
    const py = (y: number) => y * height

    ctx.lineWidth = 1

    ctx.font = "16px monospace"
    ctx.textBaseline = "top"
    ctx.fillStyle = palette.synapse

    for (let index = 0; index < mesh.edges.length; index++) {
      ctx.globalAlpha = 0.9 * (dt === 0 ? 0.8 : 0.55 + 0.45 * Math.sin((drift * 1000) / 1700 + index * 0.9))
      for (const [x, y] of mesh.edges[index].cells) {
        ctx.fillText("·", (x * width) / cols, (y * height) / rows)
      }
    }

    ctx.globalAlpha = 1

    for (const pulse of pulses) {
      pulse.t += (dt * tempo) / 0.9
    }

    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i]

      if (pulse.t >= 1) {
        nodes[pulse.to].flash = 1
        const onward = links.filter((edge) => edge.includes(pulse.to) && !edge.includes(pulse.from))
        const hops = pulse.hops ?? 1

        if (onward.length && Math.random() <= 0.72 - hops * 0.12 + energy * 0.2) {
          const [a, b] = onward[Math.floor(Math.random() * onward.length)]
          pulses.push({ from: pulse.to, to: a === pulse.to ? b : a, t: 0, color: pulse.color, hops: hops + 1 })
        }
        pulses.splice(i, 1)
        continue
      }

      const from = nodes[pulse.from]
      const to = nodes[pulse.to]
      const x = (Math.round((from.x + (to.x - from.x) * pulse.t) * cols) * width) / cols
      const y = (Math.round((from.y + (to.y - from.y) * pulse.t) * rows) * height) / rows
      ctx.fillStyle = pulse.color
      ctx.globalAlpha = 0.9
      ctx.fillText("●", x, y)
    }

    ctx.globalAlpha = 1

    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      node.flash = Math.max(0, node.flash - dt * 1.4)
      ctx.fillStyle = palette.signal
      ctx.globalAlpha = 0.5 + node.flash * 0.5 + energy * 0.2
      ctx.fillText(
        Array.from(signals.hubs.values()).includes(index)
          ? "◈"
          : node.flash > 0.45
            ? "◉"
            : mesh.nodes[index].degree > 3
              ? "●"
              : "•",
        px(node.x),
        py(node.y),
      )
    }

    ctx.lineWidth = 1
    for (const ripple of signals.ripples) {
      const node = nodes[ripple.from]
      const radius = (2 + ripple.age * 22) * 16
      ctx.strokeStyle = palette.signal
      ctx.globalAlpha = Math.max(0, 1 - ripple.age / 0.9)
      ctx.setLineDash([1, 8])
      ctx.beginPath()
      ctx.arc(px(node.x), py(node.y), radius, 0, Math.PI * 2)
      ctx.stroke()
    }

    for (const bridge of signals.bridges) {
      const from = nodes[bridge.from]
      const to = nodes[bridge.to]
      const color = bridge.state === "done" ? palette.done : bridge.state === "fail" ? palette.fail : palette.spark
      ctx.globalAlpha = signals.fade(bridge) * 0.8
      ctx.fillStyle = color
      const length = Math.max(Math.abs(to.x - from.x) * cols, Math.abs(to.y - from.y) * rows)

      for (let cell = 1; cell < Math.ceil(length * bridge.at); cell++) {
        const t = cell / length
        const x = (Math.round((from.x + (to.x - from.x) * t) * cols) * width) / cols
        const y = (Math.round((from.y + (to.y - from.y) * t) * rows) * height) / rows
        ctx.fillText("·", x, y)
      }

      if (bridge.state !== "travel") {
        const label = `${bridge.state === "done" ? "✓" : bridge.state === "fail" ? "✗" : "▸"} ${bridge.label}`
        ctx.fillStyle = color
        ctx.fillText(label, Math.max(0, Math.min(width - label.length * 8, px(to.x) + 16)), py(to.y))
      }
    }
    ctx.setLineDash([])

    ctx.globalAlpha = 1
  })

  return (
    <canvas
      ref={ref}
      data-component={props.variant === "overview" ? "neural-overview" : "neural-field"}
      class={props.class}
      aria-hidden="true"
    />
  )
}

export const NeuralLine: Component<{ sessionIDs?: readonly string[]; class?: string }> = (props) => {
  const activity = getSharedNeuralActivity()
  const nodes = buildNodes(16, 7).map((node, index) => ({ ...node, x: (index + 0.5) / 16, y: 0.5 }))
  const links = nodes.slice(0, -1).map((_, index): [number, number] => [index, index + 1])
  const pulses: Pulse[] = []
  const cursor = { value: activity.cursor }
  let label: { text: string; until: number } | undefined

  const ref = useCanvasLoop((ctx, width, height, dt, palette) => {
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
  const links = nodes.slice(0, -1).map((_, index): [number, number] => [index, index + 1])
  const pulses: Pulse[] = []
  const cursor = { value: activity.cursor }

  const ref = useCanvasLoop((ctx, width, height, dt, palette) => {
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

  const ref = useCanvasLoop((ctx, width, height, dt, palette) => {
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

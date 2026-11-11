import type { NeuralSignal, NeuralSignalKind } from "./neural-activity"
import type { MeshNode } from "./neural-mesh"

export type NeuralBridge = {
  call?: string
  label: string
  from: number
  to: number
  at: number
  state: "travel" | "wait" | "done" | "fail"
  settled: number
  reached: number
}

function hash(value: string) {
  let state = 2166136261

  for (const char of value) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0

  return state
}

// Session hubs and tool outcomes retain their identity while the mesh lives.
// Event kinds, bridge cap and fade duration match the TUI neural renderer.
export class NeuralMeshActivity {
  readonly hubs = new Map<string, number>()
  readonly tools = new Map<string, number>()
  bridges: NeuralBridge[] = []
  scans: number[] = []
  glitches: { y: number; height: number; shift: number; life: number }[] = []
  private glitchSpawn = 0
  ripples: { from: number; age: number }[] = []
  private clock = 0

  constructor(private readonly nodes: MeshNode[]) {}

  hub(sessionID: string) {
    const known = this.hubs.get(sessionID)

    if (known !== undefined) return known
    const taken = new Set(this.hubs.values())

    const candidates = this.nodes
      .flatMap((node, index) => (taken.has(index) ? [] : [{ index, degree: node.degree }]))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 6)

    const selected = candidates[hash(sessionID) % Math.max(1, candidates.length)]?.index ?? 0
    this.hubs.set(sessionID, selected)

    return selected
  }

  take(signal: NeuralSignal): { hub: number; kind: NeuralSignalKind; all: boolean } {
    const hub = this.hub(signal.sessionID)
    const node = this.nodes[hub]!
    node.flash = Math.max(node.flash, signal.kind === "think" ? 0.5 : signal.kind === "write" ? 0.7 : 1)

    if (signal.kind === "tool") {
      const label = signal.label ?? "tool"
      let to = this.tools.get(label)

      if (to === undefined) {
        const hubs = new Set(this.hubs.values())
        const free = this.nodes.flatMap((_, index) => (index !== hub && !hubs.has(index) ? [index] : []))
        to = free[hash(label) % Math.max(1, free.length)] ?? hub
        this.tools.set(label, to)
      }

      this.bridges.push({ call: signal.call, label, from: hub, to, at: 0, state: "travel", settled: 0, reached: 0 })

      if (this.bridges.length > 8) this.bridges.shift()
    }

    if (signal.kind === "done" || signal.kind === "fail") {
      const bridge = this.bridges.find(
        (item) => item.call === signal.call && (item.state === "travel" || item.state === "wait"),
      )

      if (bridge) {
        bridge.state = signal.kind
        bridge.settled = this.clock
        this.nodes[bridge.to]!.flash = 1
      }
    }

    if (signal.kind === "step" || signal.kind === "compact" || signal.kind === "answer") this.scans.push(-0.05)

    if (signal.kind === "prompt" || signal.kind === "ask") this.ripples.push({ from: hub, age: 0 })

    return { hub, kind: signal.kind, all: signal.kind === "ask" }
  }

  step(seconds: number, energy: number, cols: number, rows: number, random = Math.random) {
    this.clock += seconds
    this.glitches = this.glitches.filter((glitch) => (glitch.life -= seconds) > 0)
    this.glitchSpawn += seconds * (0.05 + energy * 1.6)

    while (this.glitchSpawn >= 1) {
      this.glitchSpawn -= 1
      this.glitches.push({
        y: Math.floor(random() * rows),
        height: 1 + Math.floor(random() * 3),
        shift: Math.round((random() - 0.5) * 16),
        life: 0.08 + random() * 0.22,
      })
    }

    this.scans = this.scans.map((y) => y + (seconds * 34) / rows).filter((y) => y < 1.1)
    this.ripples = this.ripples.filter((ripple) => (ripple.age += seconds) < 0.9)
    this.bridges = this.bridges.filter((bridge) => {
      if (bridge.state === "travel") {
        bridge.at = Math.min(
          1,
          bridge.at +
            (seconds * (22 + energy * 30)) /
              Math.max(
                1,
                Math.max(
                  Math.abs(this.nodes[bridge.to]!.x - this.nodes[bridge.from]!.x) * cols,
                  Math.abs(this.nodes[bridge.to]!.y - this.nodes[bridge.from]!.y) * rows,
                ),
              ),
        )

        if (bridge.at === 1) {
          bridge.state = "wait"
          bridge.reached = this.clock
          this.nodes[bridge.to]!.flash = 1
        }
      }

      return (
        bridge.state === "travel" ||
        (bridge.state === "wait" ? this.clock - bridge.reached < 30 : this.clock - bridge.settled < 1.8)
      )
    })
  }

  fade(bridge: NeuralBridge) {
    return bridge.state === "travel" || bridge.state === "wait"
      ? 1
      : Math.max(0, 1 - (this.clock - bridge.settled) / 1.8)
  }
}

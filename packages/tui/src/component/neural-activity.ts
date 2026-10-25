import type { OpenCodeEvent } from "@orchestra/client"
import { createSignal } from "solid-js"
import { useClient } from "../context/client"

// What the agents are doing, read straight off the event stream so the neuron network can show
// it. Every action heats the network and the heat cools when the agents go quiet:
//   heat     a level per Session plus a global one, decaying with a half-life of a couple of
//            seconds, so a model streaming text keeps it warm and a burst of tool calls makes it boil
//   signals  a short ring of discrete actions (a tool called and how it ended, a step, a prompt)
//            that each canvas reads from its own cursor and turns into a visible effect
// Canvases sample both every frame, so a delta never re-runs Solid; the `pulse` signal is a
// slow, rounded copy for text that reads the level.

export type NeuralSignalKind =
  | "write"
  | "think"
  | "tool"
  | "done"
  | "fail"
  | "step"
  | "prompt"
  | "compact"
  // A question or permission request waits for the user, and the user's answer to it.
  | "ask"
  | "answer"
  // The user moved to another session or project.
  | "select"
export type NeuralSignal = Readonly<{
  seq: number
  kind: NeuralSignalKind
  sessionID: string
  // The tool call's ID and its name, so the ending of a call finds the effect its start began.
  call?: string
  label?: string
}>

const SIGNAL_RING = 128
const COOLING_SECONDS = 2.4
// Streaming text arrives as many small deltas: a canvas sees at most one write a Session per beat.
const STREAM_BEAT_MS = 80

const WEIGHT = {
  "session.text.delta": 0.4,
  "session.reasoning.delta": 0.3,
  "session.tool.input.delta": 0.12,
  "session.compaction.delta": 0.2,
  "session.tool.input.started": 1,
  "session.tool.called": 3,
  "session.tool.progress": 0.4,
  "session.tool.success": 1.5,
  "session.tool.failed": 2.5,
  "session.shell.started": 2,
  "session.step.started": 2,
  "session.execution.started": 1.5,
  "session.inbox.enqueued": 2,
  "session.compaction.started": 2,
} satisfies Partial<Record<OpenCodeEvent["type"], number>>
type Weighted = Extract<OpenCodeEvent, { type: keyof typeof WEIGHT }>

export class NeuralActivity {
  private heat = 0
  private sessionHeat = new Map<string, number>()
  private cooled = performance.now()
  private ring: NeuralSignal[] = []
  private seq = 0
  private beats = new Map<string, number>()
  private tools = new Map<string, string>()
  private pulseSignal = createSignal(0)
  private latestSignal = createSignal<string | undefined>()

  constructor() {
    // A slow copy of the level for text such as a meter in a card footer.
    setInterval(() => {
      const level = Math.round(this.level() * 20) / 20
      if (level !== this.pulseSignal[0]()) this.pulseSignal[1](level)
      if (level === 0 && this.latestSignal[0]()) this.latestSignal[1](undefined)
    }, 250).unref?.()
  }

  // Rounded level for display, updated a few times a second.
  get pulse() {
    return this.pulseSignal[0]
  }

  // The newest discrete action, such as a tool's name, until the network cools down.
  get latest() {
    return this.latestSignal[0]
  }

  get cursor() {
    return this.seq
  }

  // 0 when quiet, approaching 1 while agents stream and call tools without pause. Given Sessions,
  // only their combined heat counts.
  level(sessionIDs?: readonly string[]) {
    this.cool()
    const heat = sessionIDs ? sessionIDs.reduce((sum, id) => sum + (this.sessionHeat.get(id) ?? 0), 0) : this.heat
    return 1 - Math.exp(-heat / 10)
  }

  since(cursor: number) {
    if (cursor >= this.seq) return []
    return this.ring.filter((signal) => signal.seq > cursor)
  }

  // The user chose another session or project: its hub fires and the network turns to it.
  select(sessionID: string) {
    this.push({ kind: "select", sessionID })
  }

  take(event: OpenCodeEvent) {
    const decision = this.decision(event)
    if (decision) return this.push(decision)
    if (!weighted(event)) return
    const weight = WEIGHT[event.type]
    const sessionID = event.data.sessionID
    this.cool()
    this.heat += weight
    this.sessionHeat.set(sessionID, (this.sessionHeat.get(sessionID) ?? 0) + weight)
    const signal = this.translate(event, sessionID)
    if (!signal) return
    if ((signal.kind === "write" || signal.kind === "think") && !this.beat(`${sessionID}:${signal.kind}`)) return
    this.push(signal)
  }

  private push(signal: Omit<NeuralSignal, "seq">) {
    this.cool()
    if (signal.kind === "ask" || signal.kind === "answer" || signal.kind === "select") {
      this.heat += 2
      this.sessionHeat.set(signal.sessionID, (this.sessionHeat.get(signal.sessionID) ?? 0) + 2)
    }
    this.seq += 1
    this.ring.push({ ...signal, seq: this.seq })
    if (this.ring.length > SIGNAL_RING) this.ring.shift()
    if (signal.label) this.latestSignal[1](signal.label)
  }

  // A decision waiting for the user, and its resolution, whichever way it was asked.
  private decision(event: OpenCodeEvent): Omit<NeuralSignal, "seq"> | undefined {
    switch (event.type) {
      case "form.created":
        return { kind: "ask", sessionID: event.data.form.sessionID }
      case "permission.asked":
        return { kind: "ask", sessionID: event.data.sessionID }
      case "form.replied":
      case "form.cancelled":
      case "permission.replied":
        return { kind: "answer", sessionID: event.data.sessionID }
    }
  }

  private translate(event: Weighted, sessionID: string): Omit<NeuralSignal, "seq"> | undefined {
    switch (event.type) {
      case "session.text.delta":
        return { kind: "write", sessionID }
      case "session.reasoning.delta":
        return { kind: "think", sessionID }
      case "session.tool.input.started":
        this.tools.set(event.data.id, event.data.name)
        if (this.tools.size > 256) this.tools.delete(this.tools.keys().next().value!)
        return
      case "session.tool.called":
        return { kind: "tool", sessionID, call: event.data.id, label: this.tools.get(event.data.id) ?? "tool" }
      case "session.tool.success":
        return { kind: "done", sessionID, call: event.data.id, label: this.tools.get(event.data.id) }
      case "session.tool.failed":
        return { kind: "fail", sessionID, call: event.data.id, label: this.tools.get(event.data.id) }
      case "session.shell.started":
        return { kind: "tool", sessionID, call: `shell:${event.id}`, label: "shell" }
      case "session.step.started":
        return { kind: "step", sessionID }
      case "session.inbox.enqueued":
        return { kind: "prompt", sessionID }
      case "session.compaction.started":
        return { kind: "compact", sessionID }
    }
  }

  private beat(key: string) {
    const now = performance.now()
    if (now - (this.beats.get(key) ?? 0) < STREAM_BEAT_MS) return false
    this.beats.set(key, now)
    return true
  }

  private cool() {
    const now = performance.now()
    const factor = Math.exp(-(now - this.cooled) / 1000 / COOLING_SECONDS)
    this.cooled = now
    this.heat *= factor
    this.sessionHeat.forEach((heat, id) => {
      if (heat * factor < 0.01) return this.sessionHeat.delete(id)
      this.sessionHeat.set(id, heat * factor)
    })
  }
}

function weighted(event: OpenCodeEvent): event is Weighted {
  return event.type in WEIGHT
}

const registry = new WeakMap<object, NeuralActivity>()

// One activity tracker per client, shared by every canvas on screen.
export function useNeuralActivity() {
  const client = useClient()
  const existing = registry.get(client)
  if (existing) return existing
  const activity = new NeuralActivity()
  client.event.listen(({ details }) => activity.take(details))
  registry.set(client, activity)
  return activity
}

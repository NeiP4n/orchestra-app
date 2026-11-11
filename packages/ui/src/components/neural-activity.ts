import type { OrchestraEvent } from "@orchestra/client"

// What the agents are doing, read straight off the event stream so the
// neuron network can show it. Ported from the TUI
// (packages/tui/src/component/neural-activity.ts) so the web UI shows the
// same activity with the same weights:
//   heat     a level per Session plus a global one, decaying with a half-life
//            of 2.4s, so a model streaming text keeps it warm and a burst of
//            tool calls makes it boil
//   signals  a short ring of discrete actions (a tool called and how it ended,
//            a step, a prompt) that each canvas reads from its own cursor and
//            turns into a visible effect
// Canvases sample both every frame, so a delta never re-renders Solid; the
// `pulse` is a slow, rounded copy for text and dots that read the level.

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

export const NEURAL_WEIGHT = {
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
} satisfies Partial<Record<OrchestraEvent["type"], number>>

type Weighted = Extract<OrchestraEvent, { type: keyof typeof NEURAL_WEIGHT }>

// How busy the agents are: a small floor for each running Session plus what
// they are doing now. Same floor as the TUI (useNeuralEnergy).
export function neuralEnergyFloor(runningSessions: number): number {
  return runningSessions > 0 ? 0.12 + runningSessions * 0.06 : 0.02
}

export class NeuralActivity {
  private heat = 0
  private sessionHeat = new Map<string, number>()
  private cooled = performance.now()
  private ring: NeuralSignal[] = []
  private seq = 0
  private beats = new Map<string, number>()
  private tools = new Map<string, string>()
  private pulseValue = 0
  private latestValue: string | undefined
  private pulseListeners = new Set<(level: number) => void>()
  private pulseTimer: ReturnType<typeof setInterval> | undefined

  private startPulse() {
    if (this.pulseTimer) return
    // Canvases sample lazily. Only a live text subscriber needs a pulse timer.
    this.pulseTimer = setInterval(() => {
      const level = Math.round(this.level() * 20) / 20

      if (level !== this.pulseValue) {
        this.pulseValue = level
        this.pulseListeners.forEach((listener) => listener(level))
      }

      if (level === 0 && this.latestValue) this.latestValue = undefined
    }, 250)
    this.pulseTimer.unref?.()
  }

  // Rounded level for display, updated a few times a second. Subscribe to
  // be told when it changes; canvases read level() every frame instead.
  get pulse() {
    return Math.round(this.level() * 20) / 20
  }

  subscribePulse(listener: (level: number) => void): () => void {
    this.pulseListeners.add(listener)
    this.startPulse()

    return () => {
      this.pulseListeners.delete(listener)

      if (this.pulseListeners.size === 0) this.dispose()
    }
  }

  // The newest discrete action, such as a tool's name, until the network cools down.
  get latest() {
    if (this.pulse === 0) this.latestValue = undefined

    return this.latestValue
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

  take(event: OrchestraEvent) {
    const decision = this.decision(event)

    if (decision) return this.push(decision)

    if (!weighted(event)) return
    const weight = NEURAL_WEIGHT[event.type]
    const sessionID = event.data.sessionID
    this.cool()
    this.heat += weight
    this.sessionHeat.set(sessionID, (this.sessionHeat.get(sessionID) ?? 0) + weight)
    const signal = this.translate(event, sessionID)

    if (!signal) return

    if ((signal.kind === "write" || signal.kind === "think") && !this.beat(`${sessionID}:${signal.kind}`)) return
    this.push(signal)
  }

  // Stop the pulse timer. The activity keeps its heat and ring; call this
  // when the page no longer needs live levels.
  dispose() {
    clearInterval(this.pulseTimer)
    this.pulseTimer = undefined
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

    if (signal.label) this.latestValue = signal.label
  }

  // A decision waiting for the user, and its resolution, whichever way it was asked.
  private decision(event: OrchestraEvent): Omit<NeuralSignal, "seq"> | undefined {
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
    const last = this.beats.get(key)
    // A missing beat means "never beaten": comparing against 0 would
    // suppress every stream signal while performance.now() is under the
    // beat window (the first 80ms of the process).

    if (last !== undefined && now - last < STREAM_BEAT_MS) return false
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

function weighted(event: OrchestraEvent): event is Weighted {
  return event.type in NEURAL_WEIGHT
}

let shared: NeuralActivity | undefined

// One activity tracker per page, shared by every canvas on screen. The app
// feeds it from the server event stream (see app/src/neural/feed.tsx).
export function getSharedNeuralActivity(): NeuralActivity {
  shared ??= new NeuralActivity()

  return shared
}

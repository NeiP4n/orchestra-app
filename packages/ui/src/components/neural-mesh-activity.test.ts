import { expect, test } from "bun:test"
import { buildNeuralMesh } from "./neural-mesh"
import { NeuralMeshActivity } from "./neural-mesh-activity"

function state() {
  const nodes = buildNeuralMesh(80, 30).nodes.map((node) => ({ ...node, x: node.x / 80, y: node.y / 30 }))

  return new NeuralMeshActivity(nodes)
}

test("a session retains its hub and a tool retains its neuron", () => {
  const activity = state()
  const hub = activity.hub("worker-one")

  expect(activity.hub("worker-one")).toBe(hub)
  expect(activity.hub("worker-two")).not.toBe(hub)
  activity.take({ seq: 1, kind: "tool", sessionID: "worker-one", call: "call-one", label: "read" })
  const first = activity.bridges[0]!

  activity.take({ seq: 2, kind: "tool", sessionID: "worker-one", call: "call-two", label: "read" })
  expect(activity.bridges[1]!.to).toBe(first.to)
  expect(first.to).not.toBe(first.from)
})

test("tool completion finds only its own bridge and fades after the TUI 1800ms", () => {
  const activity = state()
  activity.take({ seq: 1, kind: "tool", sessionID: "one", call: "a", label: "read" })
  activity.take({ seq: 2, kind: "tool", sessionID: "one", call: "b", label: "write" })
  activity.take({ seq: 3, kind: "fail", sessionID: "one", call: "b" })

  expect(activity.bridges.map((bridge) => bridge.state)).toEqual(["travel", "fail"])
  activity.step(0.9, 0, 80, 30)
  expect(activity.fade(activity.bridges[1]!)).toBeCloseTo(0.5)
  activity.step(0.91, 0, 80, 30)
  expect(activity.bridges.map((bridge) => bridge.call)).toEqual(["a"])
})

test("prompt and decision signals create bounded waves and scan lines", () => {
  const activity = state()
  activity.take({ seq: 1, kind: "prompt", sessionID: "one" })
  activity.take({ seq: 2, kind: "ask", sessionID: "one" })
  activity.take({ seq: 3, kind: "answer", sessionID: "one" })

  expect(activity.ripples).toHaveLength(2)
  expect(activity.scans).toHaveLength(1)
  activity.step(1.2, 1, 80, 30)
  expect(activity.ripples).toHaveLength(0)
  expect(activity.scans).toHaveLength(0)
})

test("tool bridges retain at most the latest eight calls", () => {
  const activity = state()

  for (let i = 0; i < 12; i++)
    activity.take({ seq: i, kind: "tool", sessionID: "one", call: `call-${i}`, label: "read" })

  expect(activity.bridges).toHaveLength(8)
  expect(activity.bridges[0]!.call).toBe("call-4")
  expect(activity.bridges[7]!.call).toBe("call-11")
})

test("a call without a completion leaves the field thirty seconds after arrival", () => {
  const activity = state()

  activity.take({ seq: 1, kind: "tool", sessionID: "one", call: "a", label: "read" })
  activity.step(10, 1, 80, 30)
  expect(activity.bridges[0]!.state).toBe("wait")
  activity.step(29, 1, 80, 30)
  expect(activity.bridges).toHaveLength(1)
  activity.step(1.1, 1, 80, 30)
  expect(activity.bridges).toHaveLength(0)
})

test("TUI horizontal tears appear faster during activity and expire", () => {
  const activity = state()

  activity.step(1, 1, 80, 30, () => 0.5)
  expect(activity.glitches).toEqual([{ y: 15, height: 2, shift: 0, life: 0.19 }])
  activity.step(0.3, 0, 80, 30, () => 0.5)
  expect(activity.glitches).toHaveLength(0)
})

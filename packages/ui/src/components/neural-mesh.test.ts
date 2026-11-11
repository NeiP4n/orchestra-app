import { expect, test } from "bun:test"
import { buildNeuralMesh } from "./neural-mesh"

test("TUI cell density and seeded resize geometry are deterministic", () => {
  expect(buildNeuralMesh(100, 40)).toEqual(buildNeuralMesh(100, 40))
  expect(buildNeuralMesh(100, 40).nodes).toHaveLength(80)
  expect(buildNeuralMesh(10, 10).nodes).toHaveLength(4)
  expect(buildNeuralMesh(44, 20).nodes).toHaveLength(20)
  expect(buildNeuralMesh(100, 40)).not.toEqual(buildNeuralMesh(101, 40))
})

test("TUI mesh cells stay on the lattice, keep node endpoints clear and record both degrees", () => {
  const mesh = buildNeuralMesh(100, 40)
  const pairs = mesh.edges.map((edge) => [edge.from, edge.to].sort((a, b) => a - b).join(":"))

  expect(new Set(pairs).size).toBe(mesh.edges.length)

  for (const node of mesh.nodes) {
    expect(Number.isInteger(node.x) && Number.isInteger(node.y)).toBe(true)
    expect(node.x >= 0 && node.x < 100 && node.y >= 0 && node.y < 40).toBe(true)
    expect(node.degree).toBe(
      mesh.edges.filter((edge) => mesh.nodes[edge.from] === node || mesh.nodes[edge.to] === node).length,
    )
  }

  for (const edge of mesh.edges) {
    const from = mesh.nodes[edge.from]
    const to = mesh.nodes[edge.to]

    expect(edge.cells).toHaveLength(Math.max(0, Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) - 1))
    expect(edge.cells.every(([x, y]) => x >= 0 && x < 100 && y >= 0 && y < 40)).toBe(true)
  }
})

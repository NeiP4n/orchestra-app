export type MeshNode = { x: number; y: number; flash: number; degree: number }

export type MeshEdge = { from: number; to: number; cells: readonly (readonly [number, number])[] }

// Same cell aspect, density, seed mixing, three-neighbor links and occasional
// long links as NeuralCanvasRenderable.build in the TUI renderer.
export function buildNeuralMesh(cols: number, rows: number, seed = 7) {
  let value = seed * 9973 + cols * 31 + rows

  const random = () => {
    value |= 0
    value = (value + 0x6d2b79f5) | 0
    let result = Math.imul(value ^ (value >>> 15), 1 | value)
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result

    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }

  const count = Math.max(4, Math.min(80, Math.round((cols * rows) / 44)))

  const nodes: MeshNode[] = Array.from({ length: count }, () => ({
    x: Math.floor(random() * cols),
    y: Math.floor(random() * rows),
    flash: random() * 0.4,
    degree: 0,
  }))

  const edges: MeshEdge[] = []
  const seen = new Set<string>()

  const connect = (from: number, to: number) => {
    const key = [from, to].sort((a, b) => a - b).join(":")

    if (seen.has(key)) return
    seen.add(key)
    nodes[from]!.degree++
    nodes[to]!.degree++
    const a = nodes[from]!
    const b = nodes[to]!
    const steps = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

    const cells = Array.from({ length: Math.max(0, steps - 1) }, (_, index): readonly [number, number] => {
      const t = (index + 1) / steps

      return [Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t)]
    })

    edges.push({ from, to, cells })
  }

  nodes.forEach((node, index) => {
    const ranked = nodes
      .flatMap((other, target) =>
        target === index ? [] : [{ target, d: Math.hypot((node.x - other.x) / 2, node.y - other.y) }],
      )
      .sort((a, b) => a.d - b.d)

    ranked
      .filter((item) => item.d < 14)
      .slice(0, 3)
      .forEach((item) => connect(index, item.target))
    const far = ranked.find((item) => item.d >= 14 && item.d < 30)

    if (far && random() < 0.18) connect(index, far.target)
  })

  return { nodes, edges }
}

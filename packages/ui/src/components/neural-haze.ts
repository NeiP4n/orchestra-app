// Ordered-dither haze ported from packages/tui/src/component/neural.tsx.
// Keep its Bayer thresholds, two-octave value noise and four tone levels.
export const NEURAL_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16)
export const NEURAL_DITHER_LEVELS = [0.1, 0.16, 0.24, 0.34]

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


export function neuralHazeLevel(x: number, y: number, drift: number, energy: number, warmth = 0, seed = 42) {
  const value = (fbm(x * 0.06 + drift * 0.9, y * 0.21 + Math.sin(drift * 0.3) * 0.6, seed) - 0.5) * 1.1 - 0.12 + energy * 0.28 + warmth
  const quantized = value * 4
  const floor = Math.floor(quantized)

  return Math.max(0, Math.min(4, floor + (quantized - floor > NEURAL_BAYER[(y % 4) * 4 + (x % 4)]! ? 1 : 0)))
}

export function paintNeuralHaze(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  drift: number,
  energy: number,
  palette: { dormant: string; signal: string },
  nodes: readonly { x: number; y: number; flash: number }[],
) {
  const cellWidth = 8
  const cellHeight = 16
  const cols = Math.ceil(width / cellWidth)
  const rows = Math.ceil(height / cellHeight)
  ctx.font = "16px monospace"
  ctx.textBaseline = "top"

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let warmth = 0

      for (const node of nodes) {
        if (node.flash < 0.2) continue
        const radius = 2 + Math.round(node.flash * 3)
        const falloff = 1 - Math.hypot((x - node.x * cols) / 2, y - node.y * rows) / (radius + 0.5)

        if (falloff > 0) warmth += falloff * node.flash * 0.55
      }

      const level = neuralHazeLevel(x, y, drift, energy, warmth)

      if (level <= 0) continue
      ctx.fillStyle = warmth > 0.15 ? palette.signal : palette.dormant
      ctx.globalAlpha = NEURAL_DITHER_LEVELS[level - 1]! * (warmth > 0.15 ? 1.35 : 1)
      ctx.fillText(level < 3 ? "░" : "▒", x * cellWidth, y * cellHeight)
    }
  }

  ctx.globalAlpha = 1
}

type FrameState = { motion: boolean; visible: boolean; hidden: boolean }

// Own exactly one scheduled frame. Paused canvases do not keep a polling RAF alive.
export function createNeuralFrameLoop(input: {
  request: (callback: (now: number) => void) => number
  cancel: (id: number) => void
  draw: (dt: number) => void
}) {
  let state: FrameState = { motion: false, visible: false, hidden: false }
  let frame: number | undefined
  let last: number | undefined
  let disposed = false
  const running = () => !disposed && state.motion && state.visible && !state.hidden
  const tick = (now: number) => {
    frame = undefined
    if (!running()) return
    const dt = last === undefined ? 0 : Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    input.draw(dt)
    if (running()) frame = input.request(tick)
  }
  const cancel = () => {
    if (frame !== undefined) input.cancel(frame)
    frame = undefined
    last = undefined
  }
  return {
    update(next: FrameState) {
      const wasRunning = running()
      state = next
      if (!running()) {
        cancel()
        if (!disposed && state.visible && !state.hidden) input.draw(0)
        return
      }
      if (!wasRunning || frame === undefined) {
        last = undefined
        frame = input.request(tick)
      }
    },
    redraw() {
      if (!disposed && state.visible && !state.hidden) input.draw(0)
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}

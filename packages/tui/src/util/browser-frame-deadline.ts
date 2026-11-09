/** The first-frame deadline is independent of any CDP/probe promise. */
export function firstFrameDeadline(options: {
  onTick(seconds: number): void
  onTimeout(): void
  limitSeconds?: number
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let stopped = false
  let seconds = 0
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    if (stopped) return
    options.onTick(++seconds)
    if (seconds >= (options.limitSeconds ?? 5)) { stopped = true; options.onTimeout(); return }
    timer = schedule(tick, 1000)
  }
  timer = schedule(tick, 1000)
  return () => { stopped = true; cancel(timer) }
}

// Only in-flight work is shared, never catalog results or credential material.
// Different Locations commonly activate the same stored connection together.
const inFlight = new Map<string, Promise<unknown>>()
export function singleFlight<A>(connectionID: string, run: () => Promise<A>): { shared: boolean; result: Promise<A> } {
  const active = inFlight.get(connectionID)
  if (active) return { shared: true, result: active as Promise<A> }
  const result = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inFlight.get(connectionID) === result) inFlight.delete(connectionID)
    })
  inFlight.set(connectionID, result)
  return { shared: false, result }
}
export function discoveryTimeout(raw = process.env.ORCHESTRA_KLINCH_DISCOVERY_TIMEOUT_MS): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1000 && value <= 120000 ? value : 60000
}
export function retryable(error: { kind: string; status?: number } | undefined): boolean {
  return (
    error?.kind === "timeout" ||
    error?.kind === "network" ||
    (error?.kind === "http" && (error.status === 429 || (error.status !== undefined && error.status >= 500)))
  )
}

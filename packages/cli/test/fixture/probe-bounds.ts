// Parent-process test helpers only. The work clock never consumes the cleanup reserve.
export async function bounded<A>(promise: Promise<A>, ms: number, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), Math.max(1, ms))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export function workClock(ms = 27000) {
  const end = Date.now() + ms
  return {
    end,
    remaining(cap = ms) {
      const left = end - Date.now()
      if (left <= 0) throw new Error("absolute probe deadline exceeded")
      return Math.min(left, cap)
    },
    wait<A>(promise: Promise<A>, label: string) {
      const left = end - Date.now()
      if (left <= 0) throw new Error("absolute probe deadline exceeded")
      return bounded(promise, left, label)
    },
  }
}
export function isolatedEnv(root: string) {
  return {
    PATH: process.env.PATH!,
    HOME: root,
    TMPDIR: root,
    XDG_DATA_HOME: root + "/data",
    XDG_CONFIG_HOME: root + "/config",
    XDG_STATE_HOME: root + "/state",
    XDG_CACHE_HOME: root + "/cache",
    ORCHESTRA_TEST_HOME: root,
    ORCHESTRA_CONFIG_CONTENT: "{}",
    ORCHESTRA_CONFIG_PROJECT_DISABLE: "true",
    ORCHESTRA_DISABLE_MODELS_FETCH: "true",
    ORCHESTRA_DISABLE_FILEWATCHER: "true",
    ORCHESTRA_DISABLE_FFF: "true",
  }
}

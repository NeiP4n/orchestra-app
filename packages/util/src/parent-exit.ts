// A process started from a terminal inherits that terminal's lifetime, but not always its signals.
// On Windows a Git Bash/mintty window signals its shell rather than the bun process the shell
// started, and bun does not surface SIGHUP for that at all, so a closed window leaves the process
// running with no terminal and nothing to react to. The parent pid is the one thing left to watch:
// once the shell that owns the terminal is gone, the process has no terminal either.
const INTERVAL_MS = 2_000

export function parentAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Calls `handler` once when the parent process disappears. Returns a function that stops watching.
 * Only Windows needs it, and only when there is a parent to watch.
 */
export function onParentExit(handler: () => void, intervalMs = INTERVAL_MS) {
  const parent = process.ppid
  if (process.platform !== "win32" || parent <= 0) return () => {}
  const timer = setInterval(() => {
    if (parentAlive(parent)) return
    clearInterval(timer)
    handler()
  }, intervalMs)
  return () => clearInterval(timer)
}

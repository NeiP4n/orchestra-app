import { text } from "node:stream/consumers"

export async function readStdin(timeoutMs?: number): Promise<string> {
  if (timeoutMs === undefined) {
    return text(process.stdin)
  }
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve("")
      }
    }, timeoutMs)

    text(process.stdin).then(
      (result) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
      },
      () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve("")
        }
      },
    )
  })
}

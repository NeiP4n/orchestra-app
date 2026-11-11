/** Sequential profile operations, never Promise.all. One failed profile does not hide the rest. */
export async function browserBatch(ids: readonly string[], work: (id: string) => Promise<unknown>, progress: (done: number, total: number) => void, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const failures: Array<{ id: string; error: unknown }> = []
  const list = [...new Set(ids)]
  progress(0, list.length)
  for (let index = 0; index < list.length; index++) {
    try { await work(list[index]!) } catch (error) { failures.push({ id: list[index]!, error }) }
    progress(index + 1, list.length)
    if (index + 1 < list.length) await sleep(350)
  }
  return { total: list.length, failures }
}

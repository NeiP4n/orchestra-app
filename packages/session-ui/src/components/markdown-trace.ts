// TEST-ONLY instrumentation for the Mermaid streaming->complete investigation
// (component-tests/session-timeline.spec.ts, "renders Mermaid in the streaming
// timeline"). No-ops unless the test sets (globalThis as any).__MD_TRACE__
// before app code runs. The data callback is lazy: when the flag is unset,
// NOTHING below the call site is evaluated (no hashing, no mapping, no object
// construction), so instrumented reactive sources and effects keep their
// production cost and timing. Logs ids, lengths, hashes, booleans and error
// CLASS names only - never content and never raw cache/block keys (hashed).
// REMOVE this module and every markdownTrace call site once the root cause is
// fixed.

export function markdownTrace(event: string, data: () => Record<string, unknown>) {
  if (!(globalThis as { __MD_TRACE__?: boolean }).__MD_TRACE__) return
  console.log("[md-trace]", JSON.stringify({ t: Date.now(), event, ...data() }))
}

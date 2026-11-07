// Bundled only into the node build (vite.node.config.ts aliases "bun" here).
// The node artifact never runs the source-install updater — that path exists
// only in source checkouts executed by Bun — but updater.ts imports it
// statically, so the bundler needs a module for `import { $ } from "bun"`.
// Loading is harmless; calling is a bug and must fail loudly.
const unavailable = (): never => {
  throw new Error("The Bun shell is unavailable in the node build; the source-install updater only runs under Bun")
}
export const $ = new Proxy(unavailable, {
  get: () => unavailable,
  apply: () => unavailable(),
})

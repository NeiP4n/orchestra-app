// Bundled only into the node build (vite.node.config.ts aliases "bun" here).
// A node artifact reports the local channel too, so it can reach the source
// updater; the capability guard in updater.ts refuses that path first. This
// shim exists so the bundler can resolve `import { $ } from "bun"`: loading
// is harmless, and any call that still happens throws loudly.
const unavailable = (): never => {
  throw new Error("The Bun shell is unavailable in the node build; the source-install updater only runs under Bun")
}
export const $ = new Proxy(unavailable, {
  get: () => unavailable,
  apply: () => unavailable(),
})

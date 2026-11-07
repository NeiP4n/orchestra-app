// Bundled only into the node build (vite.node.config.ts aliases "bun:ffi"
// here). The desktop-action tool imports bun:ffi statically, so the bundler
// needs a module to resolve. Loading is harmless; the node build has no Bun
// FFI, so any call throws loudly instead of failing at startup.
const unavailable = (): never => {
  throw new Error("bun:ffi is unavailable in the node build; native FFI calls only run under Bun")
}
export const dlopen = unavailable
export const FFIType = new Proxy(
  {},
  {
    get: unavailable,
  },
)

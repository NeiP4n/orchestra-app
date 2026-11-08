/**
 * True when this process runs under the Bun runtime: the Bun sqlite engine,
 * Bun FFI and the Bun shell exist only there. The node artifact bundles
 * throwing shims for those modules, so capability guards must check this
 * before touching them. A function (not a constant) so tests can substitute
 * it through the module registry instead of mutating the Bun global.
 */
export const bunRuntime = (): boolean => typeof Bun !== "undefined"

import { AntigravityV2Plugin } from "./v2.js"
import { AntigravityCLIOAuthPlugin as legacyServer } from "./plugin.js"
import { fromPromise } from "@orchestra/plugin/promise/adapter"

export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./plugin.js"

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./antigravity/oauth.js"

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./antigravity/oauth.js"

export { AntigravityV2Plugin } from "./v2.js"

export const AntigravityAuthEffectPlugin = fromPromise(AntigravityV2Plugin)

/** One package entrypoint for OpenCode and Orchestra V2 and V1 server plugins. */
export default { ...AntigravityV2Plugin, server: legacyServer }

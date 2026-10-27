import { AntigravityV2Plugin } from "./src/v2.ts";
import { AntigravityCLIOAuthPlugin as legacyServer } from "./src/plugin.ts";
import { fromPromise } from "@orchestra/plugin/promise/adapter";

export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin.ts";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth.ts";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth.ts";

export { AntigravityV2Plugin } from "./src/v2.ts";

export const AntigravityAuthEffectPlugin = fromPromise(AntigravityV2Plugin);

/** One package entrypoint for OpenCode and Orchestra V2 and V1 server plugins. */
export default { ...AntigravityV2Plugin, server: legacyServer };

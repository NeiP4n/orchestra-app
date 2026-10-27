import { AntigravityV2Plugin } from "./src/v2.js";
import { AntigravityCLIOAuthPlugin as legacyServer } from "./src/plugin.js";
import { fromPromise } from "@orchestra/plugin/promise/adapter";
export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin, } from "./src/plugin.js";
export { authorizeAntigravity, exchangeAntigravity, } from "./src/antigravity/oauth.js";
export { AntigravityV2Plugin } from "./src/v2.js";
export const AntigravityAuthEffectPlugin = fromPromise(AntigravityV2Plugin);
/** One package entrypoint for OpenCode and Orchestra V2 and V1 server plugins. */
export default { ...AntigravityV2Plugin, server: legacyServer };
//# sourceMappingURL=index.js.map
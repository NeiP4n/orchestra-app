export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin, } from "./plugin.js";
export { authorizeAntigravity, exchangeAntigravity, } from "./antigravity/oauth.js";
export type { AntigravityAuthorization, AntigravityTokenExchangeResult, } from "./antigravity/oauth.js";
export { AntigravityV2Plugin } from "./v2.js";
export declare const AntigravityAuthEffectPlugin: import("@orchestra/plugin/effect/plugin").Plugin<import("effect/Scope").Scope>;
/** One package entrypoint for OpenCode and Orchestra V2 and V1 server plugins. */
declare const _default: {
    server: ({ client, directory, runtimeVersion, fetch: sendFetch, canUseAccount }: import("./plugin/types.js").PluginContext) => Promise<import("./plugin/types.js").PluginResult>;
    id: string;
    setup: (context: import("@orchestra/plugin/promise/plugin").Context) => Promise<import("@orchestra/plugin/promise/plugin").Cleanup | void> | import("@orchestra/plugin/promise/plugin").Cleanup | void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map
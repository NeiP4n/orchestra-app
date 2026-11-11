interface OAuthListenerOptions {
    /**
     * How long to wait for the OAuth redirect before timing out (in milliseconds).
     */
    timeoutMs?: number;
    /** Keep the callback page pending until the token exchange finishes. */
    deferResult?: boolean;
}
export interface OAuthListener {
    /**
     * Resolves with the callback URL once Google redirects back to the local server.
     */
    waitForCallback(): Promise<URL>;
    finish(success: boolean): void;
    /**
     * Cleanly stop listening for callbacks.
     */
    close(): Promise<void>;
}
/**
 * Starts a lightweight HTTP server that listens for the Antigravity OAuth redirect
 * and resolves with the captured callback URL.
 */
export declare function startOAuthListener({ timeoutMs, deferResult }?: OAuthListenerOptions): Promise<OAuthListener>;
export {};
//# sourceMappingURL=server.d.ts.map
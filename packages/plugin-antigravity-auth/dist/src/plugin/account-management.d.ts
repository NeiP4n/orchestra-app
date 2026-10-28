import type { Plugin } from "@orchestra/plugin";
import { type AccountMetadataV3 } from "./storage.ts";
import type { PluginClient } from "./types.ts";
export declare const accountID: (account: Pick<AccountMetadataV3, "id" | "refreshToken">) => string;
export declare const accountPoolIdentity: (accounts: AccountMetadataV3[]) => string;
export declare const accountCredentialsIdentity: (accounts: AccountMetadataV3[]) => string;
export declare function loadManagedAccounts(): Promise<import("./storage.ts").AccountStorageV4 | null>;
export declare function registerAccountManagement(ctx: Plugin.Context, client: PluginClient, beforeWrite: () => Promise<void>, refreshModels: () => Promise<number>, afterWrite?: () => Promise<void>, runCredentialOperation?: <T>(operation: () => Promise<T>) => Promise<T>): Promise<import("@orchestra/plugin/promise/rpc").RpcRegistration<{
    readonly id: "antigravity.accounts";
    readonly methods: {
        readonly list: {
            readonly input: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodArray<import("zod").ZodObject<{
                id: import("zod").ZodString;
                email: import("zod").ZodString;
                enabled: import("zod").ZodBoolean;
                current: import("zod").ZodBoolean;
                verificationRequired: import("zod").ZodBoolean;
                lastUsed: import("zod").ZodNumber;
                quota: import("zod").ZodOptional<import("zod").ZodObject<{
                    remainingFraction: import("zod").ZodNumber;
                    resetTime: import("zod").ZodOptional<import("zod").ZodString>;
                    updatedAt: import("zod").ZodOptional<import("zod").ZodNumber>;
                }, import("zod/v4/core").$strip>>;
            }, import("zod/v4/core").$strip>>;
        };
        readonly connections: {
            readonly input: import("zod").ZodObject<{
                id: import("zod").ZodString;
            }, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                ids: import("zod").ZodArray<import("zod").ZodString>;
            }, import("zod/v4/core").$strip>;
        };
        readonly quotas: {
            readonly input: import("zod").ZodObject<{
                id: import("zod").ZodOptional<import("zod").ZodString>;
            }, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                report: import("zod").ZodString;
                accounts: import("zod").ZodArray<import("zod").ZodObject<{
                    id: import("zod").ZodString;
                    email: import("zod").ZodString;
                    disabled: import("zod").ZodBoolean;
                    report: import("zod").ZodString;
                }, import("zod/v4/core").$strip>>;
            }, import("zod/v4/core").$strip>;
        };
        readonly update: {
            readonly input: import("zod").ZodObject<{
                id: import("zod").ZodString;
                action: import("zod").ZodEnum<{
                    disable: "disable";
                    delete: "delete";
                    select: "select";
                    enable: "enable";
                }>;
            }, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                message: import("zod").ZodString;
            }, import("zod/v4/core").$strip>;
        };
        readonly models: {
            readonly input: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                count: import("zod").ZodNumber;
            }, import("zod/v4/core").$strip>;
        };
    };
    readonly events: {};
}>>;
//# sourceMappingURL=account-management.d.ts.map
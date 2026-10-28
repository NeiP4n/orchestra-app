import { z } from "zod";
export declare const AccountSummary: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodString;
    enabled: z.ZodBoolean;
    current: z.ZodBoolean;
    verificationRequired: z.ZodBoolean;
    lastUsed: z.ZodNumber;
    quota: z.ZodOptional<z.ZodObject<{
        remainingFraction: z.ZodNumber;
        resetTime: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const AntigravityAccountsRpc: {
    readonly id: "antigravity.accounts";
    readonly methods: {
        readonly list: {
            readonly input: z.ZodObject<{}, z.core.$strip>;
            readonly output: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                email: z.ZodString;
                enabled: z.ZodBoolean;
                current: z.ZodBoolean;
                verificationRequired: z.ZodBoolean;
                lastUsed: z.ZodNumber;
                quota: z.ZodOptional<z.ZodObject<{
                    remainingFraction: z.ZodNumber;
                    resetTime: z.ZodOptional<z.ZodString>;
                    updatedAt: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        };
        readonly connections: {
            readonly input: z.ZodObject<{
                id: z.ZodString;
            }, z.core.$strip>;
            readonly output: z.ZodObject<{
                ids: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
        };
        readonly quotas: {
            readonly input: z.ZodObject<{
                id: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly output: z.ZodObject<{
                report: z.ZodString;
                accounts: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    email: z.ZodString;
                    disabled: z.ZodBoolean;
                    report: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        };
        readonly update: {
            readonly input: z.ZodObject<{
                id: z.ZodString;
                action: z.ZodEnum<{
                    select: "select";
                    delete: "delete";
                    disable: "disable";
                    enable: "enable";
                }>;
            }, z.core.$strip>;
            readonly output: z.ZodObject<{
                message: z.ZodString;
            }, z.core.$strip>;
        };
        readonly models: {
            readonly input: z.ZodObject<{}, z.core.$strip>;
            readonly output: z.ZodObject<{
                count: z.ZodNumber;
            }, z.core.$strip>;
        };
    };
    readonly events: {};
};
export type AccountSummary = z.infer<typeof AccountSummary>;
//# sourceMappingURL=account-rpc.d.ts.map
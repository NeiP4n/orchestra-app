import type { AvailableModel } from "../quota.ts";
import { z } from "zod";
export declare const ModelCatalogCacheSchema: z.ZodObject<{
    version: z.ZodLiteral<3>;
    identity: z.ZodString;
    updatedAt: z.ZodNumber;
    accounts: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
    models: z.ZodRecord<z.ZodString, z.ZodObject<{
        displayName: z.ZodOptional<z.ZodString>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        supportsImages: z.ZodOptional<z.ZodBoolean>;
        supportsThinking: z.ZodOptional<z.ZodBoolean>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        selectable: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const OPENCODE_V2_MODEL_DEFINITIONS: {
    [k: string]: {
        name: string;
        package: string;
        limit: {
            context: number;
            output: number;
        };
        capabilities: {
            input: import("./models.ts").ModelModality[];
            output: import("./models.ts").ModelModality[];
            tools: boolean;
        };
        cost: {
            input: number;
            output: number;
            cache: {
                read: number;
                write: number;
            };
        }[];
        variants: {
            id: string;
            settings: {
                thinkingConfig: {
                    thinkingLevel: import("./models.ts").ModelThinkingLevel;
                };
            } | {
                thinkingLevel?: import("./models.ts").ModelThinkingLevel;
                thinkingConfig?: import("./models.ts").ModelThinkingConfig;
            };
        }[];
    };
};
export type V2ModelDefinitions = typeof OPENCODE_V2_MODEL_DEFINITIONS;
export declare function buildAccountModelDefinitions(models: Record<string, AvailableModel>): V2ModelDefinitions;
//# sourceMappingURL=models-v2.d.ts.map
import { OPENCODE_MODEL_DEFINITIONS } from "./models.js";
import { registerAdvertisedModelIds } from "../transform/model-resolver.js";
import { z } from "zod";
export const ModelCatalogCacheSchema = z.object({
    version: z.literal(3),
    identity: z.string(), updatedAt: z.number(),
    accounts: z.record(z.string(), z.array(z.string())),
    models: z.record(z.string(), z.object({
        displayName: z.string().optional(), maxTokens: z.number().positive().optional(), maxOutputTokens: z.number().positive().optional(),
        supportsImages: z.boolean().optional(), supportsThinking: z.boolean().optional(), disabled: z.boolean().optional(), selectable: z.boolean().optional(),
    })),
});
// Used before login or when discovery is unavailable. Once connected, Google's
// catalog replaces this list, including model IDs, names and token limits.
const fallbackModels = Object.fromEntries(["antigravity-gemini-3-flash", "antigravity-claude-sonnet-4-6", "antigravity-claude-opus-4-6-thinking"]
    .flatMap(id => OPENCODE_MODEL_DEFINITIONS[id] ? [[id, OPENCODE_MODEL_DEFINITIONS[id]]] : []));
for (const tier of ["low", "medium", "high"]) {
    fallbackModels[`antigravity-gemini-3.8-flash-${tier}`] = {
        name: `Gemini 3.8 Flash (${tier}) (Antigravity)`,
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    };
}
function definition(model) {
    return {
        name: model.name,
        package: "aisdk:@ai-sdk/google",
        limit: { ...model.limit },
        capabilities: { tools: true, ...model.modalities },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
            id,
            settings: settings.thinkingLevel
                ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } }
                : { ...settings },
        })),
    };
}
export const OPENCODE_V2_MODEL_DEFINITIONS = Object.fromEntries(Object.entries(fallbackModels).map(([id, model]) => [id, definition(model)]));
export function buildAccountModelDefinitions(models) {
    const definitions = {};
    for (const [id, model] of Object.entries(models)) {
        // Exclude completion/internal, image-generation, tier routers and explicitly
        // disabled entries. They are not selectable chat models.
        if (!/^(gemini-|claude-|gpt-oss-)/.test(id) || /image|imagen|-(disabled|tiered)$/.test(id) || model.disabled || model.selectable === false)
            continue;
        const key = `antigravity-${id}`;
        const known = OPENCODE_MODEL_DEFINITIONS[key];
        definitions[key] = definition({
            name: `${model.displayName ?? id} (Antigravity)`,
            limit: {
                context: model.maxTokens ?? known?.limit.context ?? 200000,
                output: model.maxOutputTokens ?? known?.limit.output ?? 64000,
            },
            modalities: { input: model.supportsImages === false ? ["text"] : ["text", "image", "pdf"], output: ["text"] },
            variants: known?.variants,
        });
    }
    registerAdvertisedModelIds(Object.keys(models));
    return definitions;
}
//# sourceMappingURL=models-v2.js.map
import { AmazonBedrockPlugin } from "./provider/amazon-bedrock.js"
import { AnymodelPlugin } from "./provider/anymodel.js"
import { AzurePlugin } from "./provider/azure.js"
import { CerebrasPlugin } from "./provider/cerebras.js"
import { ChatGPTPlugin } from "./provider/chatgpt.js"
import { CloudflareAIGatewayPlugin } from "./provider/cloudflare-ai-gateway.js"
import { CloudflareWorkersAIPlugin } from "./provider/cloudflare-workers-ai.js"
import { CoherePlugin } from "./provider/cohere.js"
import { DigitalOceanPlugin } from "./provider/digitalocean.js"
import { FreebuffPlugin } from "./provider/freebuff.js"
import { DynamicProviderPlugin } from "./provider/dynamic.js"
import { GithubCopilotPlugin } from "./provider/github-copilot.js"
import { GitLabPlugin } from "./provider/gitlab.js"
import { GoogleAntigravityPlugin } from "./provider/google-antigravity.js"
import { GoogleVertexPlugin } from "./provider/google-vertex.js"
import { KiloPlugin } from "./provider/kilo.js"
import { KlinchPlugin } from "./provider/klinch.js"
import { LLMGatewayPlugin } from "./provider/llmgateway.js"
import { LixPlugin } from "./provider/lix.js"
import { LMStudioPlugin } from "./provider/lmstudio.js"
import { MetaPlugin } from "./provider/meta.js"
import { ModalPlugin } from "./provider/modal.js"
import { NvidiaPlugin } from "./provider/nvidia.js"
import { OllamaPlugin } from "./provider/ollama.js"
import { OpenAIPlugin } from "./provider/openai.js"
import { SnowflakeCortexPlugin } from "./provider/snowflake-cortex.js"
import { OpencodePlugin } from "./provider/opencode.js"
import { OpenRouterPlugin } from "./provider/openrouter.js"
import { PerplexityPlugin } from "./provider/perplexity.js"
import { PoePlugin } from "./provider/poe.js"
import { PolzaPlugin } from "./provider/polza.js"
import { PromptCacheKeyPlugin } from "./provider/prompt-cache-key.js"
import { SapAICorePlugin } from "./provider/sap-ai-core.js"
import { VercelPlugin } from "./provider/vercel.js"
import { VLLMPlugin } from "./provider/vllm.js"
import { XAIPlugin } from "./provider/xai.js"
import { ZenmuxPlugin } from "./provider/zenmux.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  AmazonBedrockPlugin,
  AnymodelPlugin,
  AzurePlugin,
  CerebrasPlugin,
  ChatGPTPlugin,
  CloudflareAIGatewayPlugin,
  CloudflareWorkersAIPlugin,
  CoherePlugin,
  DigitalOceanPlugin,
  FreebuffPlugin,
  GithubCopilotPlugin,
  GitLabPlugin,
  GoogleAntigravityPlugin,
  GoogleVertexPlugin,
  KiloPlugin,
  KlinchPlugin,
  LLMGatewayPlugin,
  LixPlugin,
  LMStudioPlugin,
  MetaPlugin,
  ModalPlugin,
  NvidiaPlugin,
  OllamaPlugin,
  OpencodePlugin,
  SnowflakeCortexPlugin,
  OpenAIPlugin,
  OpenRouterPlugin,
  PerplexityPlugin,
  PoePlugin,
  PolzaPlugin,
  PromptCacheKeyPlugin,
  SapAICorePlugin,
  VercelPlugin,
  VLLMPlugin,
  XAIPlugin,
  ZenmuxPlugin,
  DynamicProviderPlugin,
]

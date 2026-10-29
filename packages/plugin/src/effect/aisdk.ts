import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Model } from "@orchestra/schema/model"
import type { ModelHooks } from "./registration.js"

export interface AISDKHooks {
  /** Runs before the SDK is built, so a hook can change the options it will be built with. */
  options: {
    readonly model: Model.Info
    readonly package: string
    readonly options: Record<string, any>
  }
  sdk: {
    readonly model: Model.Info
    readonly package: string
    readonly options: Record<string, any>
    sdk?: any
  }
  language: {
    readonly model: Model.Info
    readonly sdk: any
    readonly options: Record<string, any>
    language?: LanguageModelV3
  }
}

export interface AISDKDomain {
  readonly hook: ModelHooks<AISDKHooks>
}

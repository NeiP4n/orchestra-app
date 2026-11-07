export * as OpenCodeWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { Orchestra } from "./orchestra"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions<R = never> extends WorkerdProfile.Options {
  readonly log?: Orchestra.CreateOptions["log"]
  readonly workspaceProviders?: Orchestra.CreateOptions["workspaceProviders"]
  readonly instances?: Orchestra.CreateOptions<R>["instances"]
}

export const create = <R = never>({ log, workspaceProviders, instances, ...options }: CreateOptions<R>) => {
  const profile = WorkerdProfile.make(options)
  return Orchestra.create(
    { ...profile.options, log, workspaceProviders, instances },
    { overrides: profile.replacements },
  )
}

export const layer = <R = never>(
  options: CreateOptions<R>,
): Layer.Layer<Orchestra.Service, Config.ConfigError | Error, Exclude<R, Scope.Scope>> =>
  Layer.effect(Orchestra.Service, create(options))

export type Interface = Orchestra.Interface
export type Requirements = Scope.Scope

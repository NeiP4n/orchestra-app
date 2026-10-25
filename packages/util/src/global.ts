import path from "path"
import fs from "fs"
import os from "os"
import { Context, Effect, Layer } from "effect"
// XDG on runtimes with a home directory; one tmp-rooted directory on workerd.
// The variants resolve through the `workerd` bundle condition, like the
// native-module stubs, so no runtime sniffing happens here.
import { roots } from "#global-roots"
import { Flock } from "./flock.js"
import { makeGlobalNode } from "./effect/app-node.js"

const app = "orchestra"
const { data, cache, config, state, tmp } = roots(app)

const paths = {
  get home() {
    return process.env.ORCHESTRA_TEST_HOME ?? process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  get data() {
    return process.env.ORCHESTRA_DATA_DIR ?? process.env.OPENCODE_DATA_DIR ?? data
  },
  get bin() {
    return path.join(this.cache, "bin")
  },
  get log() {
    return path.join(this.data, "log")
  },
  get repos() {
    return path.join(this.data, "repos")
  },
  get cache() {
    return process.env.ORCHESTRA_CACHE_DIR ?? process.env.OPENCODE_CACHE_DIR ?? cache
  },
  get config() {
    return process.env.ORCHESTRA_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR ?? config
  },
  get state() {
    return process.env.ORCHESTRA_STATE_DIR ?? process.env.OPENCODE_STATE_DIR ?? state
  },
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

export class Service extends Context.Service<Service, Interface>()("@orchestra/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  // The acquired service canonicalizes default tmp; use it instead of Path.tmp for path comparisons.
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: input.tmp ?? Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const acquire = (input: Partial<Interface>) =>
  Effect.gen(function* () {
    const service = Service.of(make(input))
    yield* Effect.promise(() =>
      Promise.all(
        [service.data, service.config, service.state, service.log, service.bin, service.repos, service.tmp].map(
          (directory) => fs.promises.mkdir(directory, { recursive: true }),
        ),
      ),
    )
    const canonicalTmp = yield* Effect.promise(() => fs.promises.realpath(service.tmp))
    return Service.of({ ...service, tmp: input.tmp ?? canonicalTmp })
  })

const layer = Layer.effect(
  Service,
  Effect.suspend(() =>
    acquire({ config: process.env.ORCHESTRA_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR ?? Path.config }),
  ),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, acquire(input))

export * as Global from "./global.js"

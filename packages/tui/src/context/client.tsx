import type { OrchestraClient, OrchestraEvent } from "@orchestra/client"
import { createClientConnection, createPersistentPtyClient, createPtyClient } from "@orchestra/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createResource, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"

type ManagedService = {
  reconnect: (signal: AbortSignal) => Promise<{ api: OrchestraClient; url?: string }>
  restart: () => Promise<void>
  openToNetwork?: () => Promise<void>
}

type ClientEventMap = { [Type in OrchestraEvent["type"]]: Extract<OrchestraEvent, { type: Type }> }

export const { use: useClient, provider: ClientProvider } = createSimpleContext({
  name: "Client",
  init: (props: { api: OrchestraClient; url?: string; service?: ManagedService }) => {
    const log = useLog({ component: "client" })
    const service = props.service
    const events = createGlobalEmitter<ClientEventMap>()
    let api = props.api
    let url = props.url
    let persistentPty = url ? createPersistentPtyClient(api, { url }) : undefined
    let pty = url ? createPtyClient(api, { url }) : undefined

    const [backendInfo, { refetch: refreshBackendInfo }] = createResource(async () => {
      try { return await api.server.info() } catch { return undefined }
    })
    const connection = createClientConnection(api, {
      reconnect: service
        ? async (signal) => {
            const next = await service.reconnect(signal)
            api = next.api
            if (next.url) url = next.url
            if (url) persistentPty = createPersistentPtyClient(api, { url })
            if (url) pty = createPtyClient(api, { url })
            void refreshBackendInfo()
            return api
          }
        : undefined,
      onEvent(event) {
        events.emit(event.type, event)
      },
      log,
    })

    onCleanup(() => {
      events.clear()
    })

    return {
      backendInfo,
      supports(feature: "projectDebug" | "orphanCleanup" | "projectWork") {
        const info = backendInfo.latest
        return info ? info.capabilities?.[feature] === true : undefined
      },
      get isLocal() {
        if (!url) return true
        try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) } catch { return false }
      },
      get api() {
        return api
      },
      get persistentPty() {
        if (!persistentPty) throw new Error("Persistent terminal server endpoint is unavailable")
        return persistentPty
      },
      // The plain (non-persistent) terminal endpoint, which works where the persistent daemon does not.
      get pty() {
        if (!pty) throw new Error("Terminal server endpoint is unavailable")
        return pty
      },
      event: {
        on: events.on,
        listen: events.listen,
      },
      connection,
      restart: service?.restart,
      openToNetwork: service?.openToNetwork,
    }
  },
})

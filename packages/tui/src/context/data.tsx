import { createData } from "@orchestra/client/solid"
import type { LocationRef } from "@orchestra/client"
import type { Plugin } from "@orchestra/plugin/tui"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"

export { locationKey } from "@orchestra/client/solid"
export type { FormWithLocation } from "@orchestra/client/solid"

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  // onError replaces logging refresh failures, for data layers whose server answers only part of the API.
  init: (props: { directory: string; onError?: (error: unknown) => void }) => {
    const client = useClient()
    const data = createData({
      api: () => client.api,
      event: client.event,
      connection: client.connection,
      directory: props.directory,
      onError: props.onError,
    })
    data satisfies Plugin.Context["data"]
    const [generatingTitles, setGeneratingTitles] = createStore<Record<string, boolean | undefined>>({})
    return {
      ...data,
      location: {
        ...data.location,
        async sync(ref?: LocationRef) {
          // Only the identity check (syncInfo) may reject: it is what
          // "location unavailable" means. Catalog and config syncs are
          // best-effort and must not lock the session when one of them fails,
          // but a failure is logged rather than silently discarded.
          await data.location.syncInfo(ref)
          const settled = await Promise.allSettled([data.location.sync(ref), data.location.config.sync(ref)])
          if (settled[1].status === "rejected") console.error("Failed to sync location config", settled[1].reason)
        },
      },
      session: {
        ...data.session,
        title: {
          pending: (sessionID: string) => generatingTitles[sessionID] === true,
          async generate(sessionID: string) {
            if (generatingTitles[sessionID]) return
            setGeneratingTitles(sessionID, true)
            await client.api.session
              .update({ sessionID, title: "" })
              .then(() => {
                // The HTTP response can beat the renamed event. Keep pending until the new title is projected locally.
                data.session.invalidate(sessionID)
                return data.session.sync(sessionID)
              })
              .finally(() => setGeneratingTitles(sessionID, undefined))
          },
        },
      },
    }
  },
})

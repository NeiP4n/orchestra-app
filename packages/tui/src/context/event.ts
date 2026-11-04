import type { OrchestraEvent } from "@orchestra/client"
import { useClient } from "./client"

type EventMetadata = {
  directory: string | undefined
}
type OrchestraEventMap = { [Type in OrchestraEvent["type"]]: Extract<OrchestraEvent, { type: Type }> }

export function useEvent() {
  const client = useClient()

  function subscribe(handler: (event: OrchestraEvent, metadata: EventMetadata) => void) {
    return client.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory })
    })
  }

  function on<T extends OrchestraEvent["type"]>(
    type: T,
    handler: (event: OrchestraEventMap[T], metadata: EventMetadata) => void,
  ) {
    return client.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory })
    })
  }

  return {
    subscribe,
    on,
  }
}

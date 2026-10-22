import type { EventApi } from "@orchestra/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}

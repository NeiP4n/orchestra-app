import type { EventApi } from "@orchestra/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}

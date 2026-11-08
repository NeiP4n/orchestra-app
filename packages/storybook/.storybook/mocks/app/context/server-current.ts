// Stories render without a connected server: no location has synced integrations yet.
const data = {
  location: {
    default: () => ({ directory: "/tmp/story" }),
    syncInfo: async () => {},
    integration: {
      list: () => undefined,
      sync: async () => {},
    },
    // Unsynced skill catalog, same semantics as integration above: the real
    // client always builds this child store (packages/client/src/solid/data.ts),
    // so the mock must too - ComposerMiniSkills reads it on every composer story.
    skill: {
      list: () => undefined,
      sync: async () => {},
    },
  },
}

export function useServer() {
  return { ctx: { data } }
}

export function useData() {
  return data
}

export function ServerProvider(props: { children?: unknown }) {
  return props.children
}

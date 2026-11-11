import type { PersistentPtyInfo } from "@orchestra/client"
import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useData } from "./data"
import { useEvent } from "./event"
import { useStorage } from "./storage"

type SessionTerminalsState = {
  sessions: Record<string, string | null>
}

export const { use: useSessionTerminals, provider: SessionTerminalsProvider } = createSimpleContext({
  name: "SessionTerminals",
  init: () => {
    const client = useClient()
    const data = useData()
    const event = useEvent()
    const [available, setAvailable] = createSignal(false)
    // True once the server answered, so "unavailable" is not confused with "not asked yet".
    const [checked, setChecked] = createSignal(false)
    const [focus, setFocus] = createSignal<string>()
    const storage = useStorage()
    const [store, update] = storage.store<SessionTerminalsState>("session-terminal-selection", {
      initial: { sessions: {} },
    })
    const [terminals, updateTerminals] = storage.memory<Record<string, PersistentPtyInfo[]>>("session-terminals", {
      initial: {},
    })

    const loading = new Set<string>()
    const refresh = async (sessionID: string) => {
      if (!terminals[sessionID]) updateTerminals((draft) => (draft[sessionID] = []))
      loading.add(sessionID)
      const result = await client.api.experimental.persistentPty.list({ sessionID }).finally(() => loading.delete(sessionID))
      updateTerminals((draft) => (draft[sessionID] = result))
      const selected = store.sessions[sessionID]
      if (!selected || result.some((terminal) => terminal.id === selected)) return
      await update((draft) => {
        if (draft.sessions[sessionID] !== selected) return
        draft.sessions[sessionID] = null
      })
    }

    const selectTerminal = async (sessionID: string, ptyID: string | null) => {
      if (ptyID !== null && !terminals[sessionID]?.some((terminal) => terminal.id === ptyID)) return
      setFocus(ptyID ?? undefined)
      await update((draft) => {
        draft.sessions[sessionID] = ptyID
      })
    }

    for (const type of ["persistent-pty.added", "persistent-pty.removed"] as const) {
      onCleanup(
        event.on(type, (evt) => {
          if (!available() || !terminals[evt.data.sessionID]) return
          void refresh(evt.data.sessionID).catch((error) =>
            console.error("Failed to refresh persistent terminal panes", error),
          )
        }),
      )
    }
    // The event stream opens with server.connected, so this runs for the first connection and every reconnect.
    onCleanup(
      event.on("server.connected", () => {
        void client.api.server
          .info()
          .then((info) => {
            // Servers that predate the field omit it; keep offering terminals as clients did before.
            setAvailable(info.capabilities?.persistentPty !== false)
            setChecked(true)
            if (!available()) return
            Object.keys(terminals).forEach((sessionID) => {
              void refresh(sessionID).catch((error) =>
                console.error("Failed to refresh persistent terminal panes", error),
              )
            })
          })
          .catch((error) => {
            setAvailable(false)
            setChecked(true)
            console.error("Failed to read server terminal support", error)
          })
      }),
    )

    return {
      available,
      checked,
      get(sessionID: string) {
        return {
          terminals: terminals[sessionID] ?? [],
          selectedTerminalID: store.sessions[sessionID] ?? null,
        }
      },
      // True once the terminals of a session were listed, even when the list is empty.
      terminalsLoaded: (sessionID: string) => terminals[sessionID] !== undefined && !loading.has(sessionID),
      refresh,
      selectTerminal,
      async newTerminal(sessionID: string): Promise<PersistentPtyInfo> {
        const session = data.session.get(sessionID)
        const terminal = await client.api.experimental.persistentPty.create({
          sessionID,
          args: [],
          cwd: session?.location.directory,
          title: "Terminal",
          env: {},
        })
        await refresh(sessionID)
        await selectTerminal(sessionID, terminal.id)
        return terminal
      },
      shouldFocus(ptyID: string) {
        return focus() === ptyID
      },
      clearFocus(ptyID: string) {
        setFocus((current) => (current === ptyID ? undefined : current))
      },
    }
  },
})

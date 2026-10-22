import type { PanelPresentation } from "@orchestra/plugin/tui/context"
import { batch, createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"

export type PanelTarget = {
  readonly plugin: string
  readonly name: string
  readonly sessionID: string
}

export function createPanelState() {
  const [current, setCurrent] = createSignal<PanelTarget>()
  const [requested, setRequested] = createSignal<PanelPresentation>("panel")
  const [width, setWidth] = createSignal(0)
  const canSplit = () => width() > 80
  // Side panels always remain in their own column. Automatically switching to
  // fullscreen on a narrower terminal made them cover the conversation.
  // A fullscreen request is honored only when the terminal can actually split the layout.
  // Keep the requested value so widening the terminal restores the user's choice.
  const presentation = createMemo<PanelPresentation>(() =>
    requested() === "fullscreen" && canSplit() ? "fullscreen" : "panel",
  )
  return {
    current,
    width,
    canSplit,
    presentation,
    setWidth,
    open(target: PanelTarget, presentation: PanelPresentation = "panel") {
      batch(() => {
        setRequested(presentation)
        setCurrent((current) =>
          current?.plugin === target.plugin && current.name === target.name && current.sessionID === target.sessionID
            ? current
            : target,
        )
      })
    },
    close: () => setCurrent(),
    release(plugin: string) {
      if (current()?.plugin !== plugin) return
      setCurrent()
    },
    toggleFullscreen() {
      if (!canSplit()) return
      setRequested((current) => (current === "panel" ? "fullscreen" : "panel"))
    },
  }
}

const Context = createContext<ReturnType<typeof createPanelState>>()

export function PanelProvider(props: ParentProps) {
  return <Context.Provider value={createPanelState()}>{props.children}</Context.Provider>
}

export function usePanel() {
  const value = useContext(Context)
  if (!value) throw new Error("usePanel must be used within a PanelProvider")
  return value
}

export function useOptionalPanel() {
  return useContext(Context)
}

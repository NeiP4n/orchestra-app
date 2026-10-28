import { RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import {
  SCULK_SPRITE_CELL_HEIGHT,
  SCULK_SPRITE_WIDTH,
  sculkSpriteCells,
  type SculkSpriteKind,
  type SculkSpriteState,
} from "../ui/sculk-sprites"

export function SculkSprite(props: {
  kind?: SculkSpriteKind
  state?: SculkSpriteState
  backdrop?: RGBA
  label?: string
  interactive?: boolean
  onClick?: () => void
}) {
  const theme = useTheme()
  const config = useConfig().data
  const [frame, setFrame] = createSignal(0)
  const [vibrating, setVibrating] = createSignal(false)

  const kind = () => props.kind ?? "sensor"
  const state = () => (vibrating() ? "vibrating" : (props.state ?? "idle"))
  const backdrop = () => props.backdrop ?? theme.background.base

  createEffect(() => {
    if (state() === "idle" && !vibrating()) {
      setFrame(0)
      return
    }
    if (!(config.animations ?? true)) return

    // 120ms frame cycle (~8.3 FPS), perfectly matching Minecraft tick timing!
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 4)
    }, 120)
    onCleanup(() => clearInterval(timer))
  })

  // When triggered, vibration holds for 1200ms then settles back
  function triggerVibration() {
    setVibrating(true)
    const timeout = setTimeout(() => {
      setVibrating(false)
    }, 1200)
    onCleanup(() => clearTimeout(timeout))
  }

  const cells = createMemo(() => sculkSpriteCells(kind(), frame(), state()))

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={SCULK_SPRITE_WIDTH}
      onMouseUp={() => {
        if (props.interactive ?? true) triggerVibration()
        props.onClick?.()
      }}
    >
      <For each={cells()}>
        {(row) => (
          <text selectable={false}>
            <For each={row}>
              {(cell) => (
                <span
                  style={{
                    fg: cell.top ?? backdrop(),
                    bg: cell.bottom ?? backdrop(),
                  }}
                >
                  ▀
                </span>
              )}
            </For>
          </text>
        )}
      </For>
      <Show when={props.label}>
        <text fg={theme.text.muted} wrapMode="none">
          {props.label}
        </text>
      </Show>
    </box>
  )
}

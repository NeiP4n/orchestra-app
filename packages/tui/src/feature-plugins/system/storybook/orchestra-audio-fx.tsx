import type { Plugin } from "@orchestra/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { AudioWave, formatAudioWaveString } from "../../../component/audio-wave"
import { DissonanceGlitch, HarmonicFlash } from "../../../component/audio-effects"
import { StoryFooter, type StoryFooterControl } from "./footer"
import type { Story } from "./index"

const PRESETS: Record<number, { name: string; bands: number[] }> = {
  1: {
    name: "Bass Kick & Sub-Low",
    bands: [0.95, 0.85, 0.5, 0.25, 0.15, 0.08, 0.05, 0.02, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
  2: {
    name: "Warm Vocal Mid-Range",
    bands: [0.1, 0.25, 0.45, 0.7, 0.88, 0.92, 0.85, 0.65, 0.4, 0.25, 0.15, 0.1, 0.05, 0.02, 0.0, 0.0],
  },
  3: {
    name: "High Shimmer & Treble",
    bands: [0.02, 0.05, 0.08, 0.12, 0.2, 0.35, 0.5, 0.68, 0.82, 0.95, 0.9, 0.75, 0.6, 0.45, 0.3, 0.15],
  },
  4: {
    name: "Full Orchestral Spectrum",
    bands: [0.75, 0.82, 0.78, 0.88, 0.92, 0.85, 0.79, 0.9, 0.86, 0.84, 0.8, 0.75, 0.7, 0.65, 0.55, 0.4],
  },
  5: {
    name: "Tutti Majestic Forte",
    bands: [0.95, 0.92, 0.94, 0.98, 0.96, 0.93, 0.95, 0.97, 0.95, 0.92, 0.9, 0.88, 0.85, 0.82, 0.8, 0.75],
  },
  6: {
    name: "Dissonance Minor Clash",
    bands: [0.98, 0.05, 0.92, 0.08, 0.95, 0.04, 0.88, 0.1, 0.93, 0.06, 0.89, 0.05, 0.85, 0.08, 0.8, 0.02],
  },
  7: {
    name: "Harmonic Sine Cascade",
    bands: [0.2, 0.4, 0.6, 0.8, 1.0, 0.8, 0.6, 0.4, 0.2, 0.4, 0.6, 0.8, 1.0, 0.8, 0.6, 0.4],
  },
  8: {
    name: "Calibrated Resting Baseline",
    bands: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
}

function OrchestraAudioFxStory(props: { context: Plugin.Context }): JSX.Element {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme

  const [presetIndex, setPresetIndex] = createSignal(4)
  const [isPlaying, setIsPlaying] = createSignal(true)
  const [multiHeight, setMultiHeight] = createSignal(true)
  const [glitchActive, setGlitchActive] = createSignal(false)
  const [tuttiActive, setTuttiActive] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  // Dynamic animated modulation when playing
  createEffect(() => {
    if (!isPlaying()) return
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 1000)
    }, 50)
    onCleanup(() => clearInterval(timer))
  })

  const currentPreset = () => PRESETS[presetIndex()]!

  const dynamicBands = createMemo(() => {
    const base = currentPreset().bands
    if (!isPlaying()) return base
    const t = tick()
    return base.map((val, idx) => {
      if (val === 0) return 0
      const modulation = 0.18 * Math.sin(t * 0.25 + idx * 0.45)
      return Math.max(0.05, Math.min(1, val + modulation))
    })
  })

  const triggerGlitch = () => {
    setGlitchActive(false)
    setTimeout(() => setGlitchActive(true), 10)
  }

  const triggerTutti = () => {
    setTuttiActive(false)
    setTimeout(() => setTuttiActive(true), 10)
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "space",
        title: isPlaying() ? "Pause audio" : "Play audio",
        group: "Storybook",
        run: () => setIsPlaying((p) => !p),
      },
      {
        bind: "1",
        title: "Preset 1: Bass",
        group: "Storybook",
        run: () => setPresetIndex(1),
      },
      {
        bind: "2",
        title: "Preset 2: Vocal",
        group: "Storybook",
        run: () => setPresetIndex(2),
      },
      {
        bind: "3",
        title: "Preset 3: Treble",
        group: "Storybook",
        run: () => setPresetIndex(3),
      },
      {
        bind: "4",
        title: "Preset 4: Spectrum",
        group: "Storybook",
        run: () => setPresetIndex(4),
      },
      {
        bind: "5",
        title: "Preset 5: Tutti Forte",
        group: "Storybook",
        run: () => setPresetIndex(5),
      },
      {
        bind: "6",
        title: "Preset 6: Dissonance",
        group: "Storybook",
        run: () => setPresetIndex(6),
      },
      {
        bind: "7",
        title: "Preset 7: Cascade",
        group: "Storybook",
        run: () => setPresetIndex(7),
      },
      {
        bind: "8",
        title: "Preset 8: Silence",
        group: "Storybook",
        run: () => setPresetIndex(8),
      },
      {
        bind: "g",
        title: "Dissonance Glitch",
        group: "Storybook",
        run: triggerGlitch,
      },
      {
        bind: "t",
        title: "Tutti Harmonic Flash",
        group: "Storybook",
        run: triggerTutti,
      },
      {
        bind: "m",
        title: "Toggle height mode",
        group: "Storybook",
        run: () => setMultiHeight((h) => !h),
      },
    ],
  }))

  const controls: readonly StoryFooterControl[] = [
    { shortcut: "space", label: isPlaying() ? "pause" : "play" },
    { shortcut: "1-8", label: "presets" },
    { shortcut: "g", label: "glitch" },
    { shortcut: "t", label: "tutti" },
    { shortcut: "m", label: multiHeight() ? "1-row" : "5-row" },
    { shortcut: "esc", label: "index" },
  ]

  const waveHeight = () => (multiHeight() ? 5 : 1)
  const waveWidth = () => Math.min(Math.max(32, dynamicBands().length * 2), dimensions().width - 4)

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <strong>Orchestra Audio-Visual Effects</strong>
          </text>
          <text fg={theme.text.muted}>
            Preset: <span style={{ fg: theme.text.base }}>{currentPreset().name}</span>
          </text>
        </box>

        {/* Studio Equalizer Card */}
        <box
          flexDirection="column"
          padding={1}
          backgroundColor={theme.background.raised.base}
          gap={1}
        >
          <text fg={theme.text.muted}>
            Equalizer (Attack: 40ms · Decay: 380ms · Peak Hold: 260ms):
          </text>

          <box height={waveHeight()} width={waveWidth()}>
            <AudioWave
              bands={dynamicBands()}
              height={waveHeight()}
              width={waveWidth()}
              peakHold={true}
              enabled={true}
            />
          </box>

          <box flexDirection="row" gap={1}>
            <text fg={theme.text.muted}>Inline stream:</text>
            <text fg={theme.text.base}>
              {formatAudioWaveString(dynamicBands())}
            </text>
          </box>
        </box>

        {/* Acoustic Effects Showcase */}
        <box
          flexDirection="column"
          padding={1}
          backgroundColor={theme.background.raised.base}
          gap={1}
        >
          <text fg={theme.text.muted}>Acoustic Glitch & Tutti Celebration:</text>

          <box flexDirection="column" gap={1}>
            <HarmonicFlash
              active={tuttiActive()}
              duration={1000}
              width={waveWidth()}
              onComplete={() => setTuttiActive(false)}
            >
              <box flexDirection="row" gap={1} padding={1}>
                <text fg={theme.text.muted}>Agent State:</text>
                <DissonanceGlitch
                  text="Federated Symphony: Harmony 432 Hz · Tutti Resonance OK"
                  active={glitchActive()}
                  duration={300}
                  onComplete={() => setGlitchActive(false)}
                />
              </box>
            </HarmonicFlash>
          </box>
        </box>
      </box>

      <StoryFooter
        context={props.context}
        title="Orchestra Audio FX Showcase"
        details={[`Mode: ${multiHeight() ? "5-Row Studio" : "1-Row Compact"}`, `Active: ${isPlaying() ? "Live" : "Paused"}`]}
        controls={controls}
      />
    </box>
  )
}

export const orchestraAudioFxStory: Story = {
  id: "orchestra-audio-fx",
  title: "AudioWave, Dissonance Glitch & Tutti Harmonic Flash",
  render: (context) => <OrchestraAudioFxStory context={context} />,
}

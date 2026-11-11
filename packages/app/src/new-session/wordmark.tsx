import { NeuralDot } from "@orchestra/ui/neural-field"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[440px] text-v2-text-text-base"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto flex w-full items-center justify-center gap-3 py-2">
        <NeuralDot />
        <span class="font-mono text-2xl font-semibold tracking-[0.16em]">ORCHESTRA</span>
      </div>
    </div>
  )
}

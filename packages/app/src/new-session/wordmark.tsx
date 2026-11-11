import { Logo } from "@orchestra/ui/logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[440px] text-v2-text-text-base"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto w-full">
        <Logo class="block aspect-[720/129] w-full opacity-100" />
        <Logo class="wordmark-shimmer absolute inset-0 aspect-[720/129] w-full" />
      </div>
    </div>
  )
}

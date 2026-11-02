// Small orchestra mark for provider rows: the same podium-and-arc mark
// as the main logo, simplified to 16px. This file used to hold the old
// opencode square; its name is kept only so existing imports do not move.
export function OrchestraLogo(props: { class?: string }) {
  return (
    <svg
      data-component="orchestra-logo"
      aria-hidden="true"
      class={props.class}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2.5 11 A 6.5 6.5 0 0 1 13.5 11" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
      <circle cx="3.5" cy="10" r="1.1" fill="currentColor" />
      <circle cx="8" cy="5" r="1.4" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1.1" fill="currentColor" />
      <path d="M8 11 L10 13 L8 15 L6 13 Z" fill="currentColor" />
    </svg>
  )
}

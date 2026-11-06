// Small orchestra mark for provider rows and the titlebar: the Fan mark,
// simplified to 16px (5 rays to 3, 3 sound arcs to 1, nodes as dots,
// podium as a diamond). Strokes stay at least 1.1px so they do not vanish
// at small sizes. Monochrome (currentColor) so callers set the color.
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
      <path
        d="M 6.1 3.4 A 2.2 2.2 0 0 1 9.9 3.4"
        stroke="currentColor"
        stroke-width="1.1"
        fill="none"
        stroke-linecap="round"
      />
      <path d="M 8 11 L 3.4 6.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" />
      <path d="M 8 11 L 12.6 6.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" />
      <path d="M 8 11 L 8 4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
      <circle cx="3.4" cy="6.4" r="1" fill="currentColor" />
      <circle cx="12.6" cy="6.4" r="1" fill="currentColor" />
      <circle cx="8" cy="4.5" r="1.5" fill="currentColor" />
      <path d="M 8 11 L 9.75 12.5 L 8 14 L 6.25 12.5 Z" fill="currentColor" />
    </svg>
  )
}

import { createUniqueId, type ComponentProps } from "solid-js"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            <path pathLength={props.outline ? 1 : undefined} d="M8 40.5h64v16h-64Z M8 56.5h16v16h-16Z M56 56.5h16v16h-16Z M8 72.5h16v16h-16Z M56 72.5h16v16h-16Z M8 88.5h16v16h-16Z M56 88.5h16v16h-16Z M8 104.5h64v16h-64Z M88 40.5h64v16h-64Z M88 56.5h16v16h-16Z M136 56.5h16v16h-16Z M88 72.5h16v16h-16Z M88 88.5h16v16h-16Z M88 104.5h16v16h-16Z M168 40.5h64v16h-64Z M168 56.5h16v16h-16Z M168 72.5h16v16h-16Z M168 88.5h16v16h-16Z M168 104.5h64v16h-64Z M248 8.5h16v16h-16Z M248 24.5h16v16h-16Z M248 40.5h64v16h-64Z M248 56.5h16v16h-16Z M296 56.5h16v16h-16Z M248 72.5h16v16h-16Z M296 72.5h16v16h-16Z M248 88.5h16v16h-16Z M296 88.5h16v16h-16Z M248 104.5h16v16h-16Z M296 104.5h16v16h-16Z M328 40.5h64v16h-64Z M328 56.5h16v16h-16Z M376 56.5h16v16h-16Z M328 72.5h64v16h-64Z M328 88.5h16v16h-16Z M328 104.5h64v16h-64Z M408 40.5h64v16h-64Z M408 56.5h16v16h-16Z M408 72.5h64v16h-64Z M456 88.5h16v16h-16Z M408 104.5h64v16h-64Z M488 8.5h16v16h-16Z M488 24.5h16v16h-16Z M488 40.5h64v16h-64Z M488 56.5h16v16h-16Z M488 72.5h16v16h-16Z M488 88.5h16v16h-16Z M488 104.5h48v16h-48Z M568 40.5h64v16h-64Z M568 56.5h16v16h-16Z M616 56.5h16v16h-16Z M568 72.5h16v16h-16Z M568 88.5h16v16h-16Z M568 104.5h16v16h-16Z M648 40.5h64v16h-64Z M696 56.5h16v16h-16Z M648 72.5h64v16h-64Z M648 88.5h16v16h-16Z M696 88.5h16v16h-16Z M648 104.5h64v16h-64Z" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

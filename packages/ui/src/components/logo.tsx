import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -2.7 267 47.4"
      fill="none"
      shape-rendering="crispEdges"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M3 15h24v6h-24Z M3 21h6v6h-6Z M21 21h6v6h-6Z M3 27h6v6h-6Z M21 27h6v6h-6Z M3 33h6v6h-6Z M21 33h6v6h-6Z M3 39h24v6h-24Z M33 15h24v6h-24Z M33 21h6v6h-6Z M51 21h6v6h-6Z M33 27h6v6h-6Z M33 33h6v6h-6Z M33 39h6v6h-6Z M63 15h24v6h-24Z M63 21h6v6h-6Z M63 27h6v6h-6Z M63 33h6v6h-6Z M63 39h24v6h-24Z M93 3h6v6h-6Z M93 9h6v6h-6Z M93 15h24v6h-24Z M93 21h6v6h-6Z M111 21h6v6h-6Z M93 27h6v6h-6Z M111 27h6v6h-6Z M93 33h6v6h-6Z M111 33h6v6h-6Z M93 39h6v6h-6Z M111 39h6v6h-6Z M123 15h24v6h-24Z M123 21h6v6h-6Z M141 21h6v6h-6Z M123 27h24v6h-24Z M123 33h6v6h-6Z M123 39h24v6h-24Z M153 15h24v6h-24Z M153 21h6v6h-6Z M153 27h24v6h-24Z M171 33h6v6h-6Z M153 39h24v6h-24Z M183 3h6v6h-6Z M183 9h6v6h-6Z M183 15h24v6h-24Z M183 21h6v6h-6Z M183 27h6v6h-6Z M183 33h6v6h-6Z M183 39h18v6h-18Z M213 15h24v6h-24Z M213 21h6v6h-6Z M231 21h6v6h-6Z M213 27h6v6h-6Z M213 33h6v6h-6Z M213 39h6v6h-6Z M243 15h24v6h-24Z M261 21h6v6h-6Z M243 27h24v6h-24Z M243 33h6v6h-6Z M261 33h6v6h-6Z M243 39h24v6h-24Z" fill="var(--icon-weak-base)" />
        <path d="M0 12h24v6h-24Z M0 18h6v6h-6Z M18 18h6v6h-6Z M0 24h6v6h-6Z M18 24h6v6h-6Z M0 30h6v6h-6Z M18 30h6v6h-6Z M0 36h24v6h-24Z M30 12h24v6h-24Z M30 18h6v6h-6Z M48 18h6v6h-6Z M30 24h6v6h-6Z M30 30h6v6h-6Z M30 36h6v6h-6Z M60 12h24v6h-24Z M60 18h6v6h-6Z M60 24h6v6h-6Z M60 30h6v6h-6Z M60 36h24v6h-24Z M90 0h6v6h-6Z M90 6h6v6h-6Z M90 12h24v6h-24Z M90 18h6v6h-6Z M108 18h6v6h-6Z M90 24h6v6h-6Z M108 24h6v6h-6Z M90 30h6v6h-6Z M108 30h6v6h-6Z M90 36h6v6h-6Z M108 36h6v6h-6Z M120 12h24v6h-24Z M120 18h6v6h-6Z M138 18h6v6h-6Z M120 24h24v6h-24Z M120 30h6v6h-6Z M120 36h24v6h-24Z M150 12h24v6h-24Z M150 18h6v6h-6Z M150 24h24v6h-24Z M168 30h6v6h-6Z M150 36h24v6h-24Z M180 0h6v6h-6Z M180 6h6v6h-6Z M180 12h24v6h-24Z M180 18h6v6h-6Z M180 24h6v6h-6Z M180 30h6v6h-6Z M180 36h18v6h-18Z M210 12h24v6h-24Z M210 18h6v6h-6Z M228 18h6v6h-6Z M210 24h6v6h-6Z M210 30h6v6h-6Z M210 36h6v6h-6Z M240 12h24v6h-24Z M258 18h6v6h-6Z M240 24h24v6h-24Z M240 30h6v6h-6Z M258 30h6v6h-6Z M240 36h24v6h-24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}

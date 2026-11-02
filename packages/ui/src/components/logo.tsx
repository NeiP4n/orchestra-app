import { type ComponentProps } from "solid-js"

// Orchestra mark: a conductor's podium seen from above, with the five
// sections of the orchestra seated in an arc around it and the baton
// pointing from the podium to the first violin. Deliberately not a
// square-in-a-square: that was the old opencode mark.
function MarkPaths() {
  return (
    <>
      <path
        data-slot="logo-mark-arc"
        d="M10 44 A 26 26 0 0 1 54 44"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="2"
        stroke-linecap="round"
      />
      <circle cx="14" cy="40" r="3.5" fill="var(--icon-weak-base)" />
      <circle cx="23" cy="26" r="3.5" fill="var(--icon-weak-base)" />
      <circle cx="32" cy="20" r="4.5" fill="var(--icon-strong-base)" />
      <circle cx="41" cy="26" r="3.5" fill="var(--icon-weak-base)" />
      <circle cx="50" cy="40" r="3.5" fill="var(--icon-weak-base)" />
      <path
        data-slot="logo-mark-baton"
        d="M32 52 L46 30"
        stroke="var(--icon-strong-base)"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-podium"
        d="M32 44 L40 52 L32 60 L24 52 Z"
        fill="var(--icon-strong-base)"
      />
    </>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MarkPaths />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(0 8)">
        <MarkPaths />
      </g>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(0 0.5) scale(2)">
        <MarkPaths />
      </g>
      <text
        x="152"
        y="86"
        font-family="inherit"
        font-size="52"
        font-weight="600"
        letter-spacing="10"
        fill="currentColor"
      >
        ORCHESTRA
      </text>
    </svg>
  )
}

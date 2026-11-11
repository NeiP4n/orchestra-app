import { type ComponentProps } from "solid-js"

// Orchestra mark "Fan" (Веер): the conductor's podium at the bottom, five
// rays fanning upward — the five sections of the orchestra — with sound
// arcs spreading above the first violin. Deliberately not a letter O and
// not the old podium-and-arc mark: the user chose the Fan as the main
// mark (2026-11-06), the Orbit below is the secondary one. Geometry is
// the 512 grid from orchestra-brand/o-logo-new-v2.svg; colors come from
// the app icon tokens so the mark follows the app color scheme.
function FanPaths() {
  return (
    <>
      <path
        data-slot="logo-mark-arcs"
        d="M 207.5 138 A 56 56 0 0 1 304.5 138"
        fill="none"
        stroke="var(--icon-spark-base)"
        stroke-width="10"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-arcs"
        d="M 183.3 124 A 84 84 0 0 1 328.7 124"
        fill="none"
        stroke="var(--icon-spark-base)"
        stroke-width="8"
        stroke-linecap="round"
        opacity="0.7"
      />
      <path
        data-slot="logo-mark-arcs"
        d="M 159 110 A 112 112 0 0 1 353 110"
        fill="none"
        stroke="var(--icon-spark-base)"
        stroke-width="6"
        stroke-linecap="round"
        opacity="0.45"
      />
      <path
        data-slot="logo-mark-ray"
        d="M 256 366 L 82.8 266"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-ray"
        d="M 256 366 L 156 192.8"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-ray"
        d="M 256 366 L 356 192.8"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-ray"
        d="M 256 366 L 429.2 266"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        data-slot="logo-mark-ray"
        d="M 256 366 L 256 166"
        fill="none"
        stroke="var(--icon-strong-base)"
        stroke-width="20"
        stroke-linecap="round"
      />
      <circle cx="82.8" cy="266" r="24" fill="var(--icon-weak-base)" />
      <circle cx="156" cy="192.8" r="24" fill="var(--icon-weak-base)" />
      <circle cx="356" cy="192.8" r="24" fill="var(--icon-weak-base)" />
      <circle cx="429.2" cy="266" r="24" fill="var(--icon-weak-base)" />
      <circle cx="256" cy="166" r="32" fill="var(--icon-strong-base)" />
      <path
        data-slot="logo-mark-podium"
        d="M 256 366 L 290 400 L 256 434 L 222 400 Z"
        fill="var(--icon-strong-base)"
      />
    </>
  )
}

// Orchestra mark "Orbit" (Орбита): the improved letter O — a ring of
// musicians with five section nodes, the top node larger (the conductor),
// a spark flying out of the gap on the right, the podium diamond inside.
// Secondary mark, for places where the Fan does not fit. Geometry is the
// 512 grid from orchestra-brand/o-logo-new-v1.svg.
function OrbitPaths() {
  return (
    <>
      <path
        data-slot="logo-orbit-ring"
        d="M 391.9 319.4 A 150 150 0 1 1 391.9 192.6"
        fill="none"
        stroke="var(--icon-weak-base)"
        stroke-width="44"
        stroke-linecap="round"
      />
      <circle cx="113.3" cy="209.6" r="30" fill="var(--icon-weak-base)" />
      <circle cx="167.8" cy="377.4" r="30" fill="var(--icon-weak-base)" />
      <circle cx="344.2" cy="377.4" r="30" fill="var(--icon-weak-base)" />
      <circle cx="398.7" cy="209.6" r="30" fill="var(--icon-weak-base)" />
      <circle cx="256" cy="106" r="42" fill="var(--icon-strong-base)" />
      <circle cx="392" cy="256" r="9" fill="var(--icon-spark-base)" opacity="0.45" />
      <circle cx="424" cy="256" r="20" fill="var(--icon-spark-base)" />
      <path
        data-slot="logo-orbit-podium"
        d="M 256 342 L 286 372 L 256 402 L 226 372 Z"
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
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <FanPaths />
    </svg>
  )
}

export const Orbit = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-orbit"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <OrbitPaths />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 640"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(0 64)">
        <FanPaths />
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
      <g transform="translate(0 0.5) scale(0.25)">
        <FanPaths />
      </g>
      <text
        direction="ltr"
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

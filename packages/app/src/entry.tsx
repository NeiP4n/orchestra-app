// @refresh reload

import "@/runtime/polyfills"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { createWebPlatform } from "@/runtime/platform/web"
import { isStandalone, PwaRoutePersistence, restorePwaRoute } from "@/runtime/platform/pwa"
import { KeyboardInsets } from "@/runtime/platform/keyboard"
import en from "@/runtime/i18n/en"
import zh from "@/runtime/i18n/zh"
import { authFromToken } from "@/runtime/server/api"
import pkg from "../package.json"
import { ServerConnection } from "@/runtime/server/registry"

const getLocale = () => {
  if (typeof navigator === "undefined") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]

  for (const language of languages) {
    if (!language) continue

    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }

  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()

  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const root = document.getElementById("root")

if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)

  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const web = createWebPlatform(pkg.version)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"), { once: true })
}

if (import.meta.env.VITE_SENTRY_DSN) {
  // Sentry stays out of the startup bundle: it loads only when a DSN is
  // configured, after the app has started rendering.
  const dsn = import.meta.env.VITE_SENTRY_DSN
  const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE
  const release = import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`
  const channel = import.meta.env.ORCHESTRA_CHANNEL
  void import("@sentry/solid").then(({ init }) =>
    init({
      dsn,
      environment,
      release,
      initialScope: {
        tags: {
          platform: "web",
        },
      },
      integrations: (integrations) => {
        return integrations.filter(
          (i) => i.name !== "Breadcrumbs" && !(channel === "prod" && i.name === "GlobalHandlers"),
        )
      },
    }),
  )
}

if (root instanceof HTMLElement && root.dataset.opencodeMounted === undefined) {
  // Lazy chunks can import the entry chunk back under a distinct URL, so claim the root before async startup.
  root.dataset.opencodeMounted = ""
  // If startup fails before the first render, show an error page instead of leaving an empty #root.
  void loadInitialLocale().then((locale) => {
    const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
    clearAuthToken()
    const standalone = isStandalone()
    root.dataset.standalone = String(standalone)

    if (standalone) restorePwaRoute()

    const server: ServerConnection.Http | undefined = web.currentServerUrl
      ? {
          type: "http",
          authToken: !!auth,
          http: {
            url: web.currentServerUrl,
            ...auth,
          },
        }
      : undefined

    render(
      () => (
        <PlatformProvider value={web.platform}>
          <AppBaseProviders locale={locale} defaultTheme="sculk">
            <AppInterface
              canonicalLocalServer={server ? ServerConnection.key(server) : undefined}
              servers={server ? [server] : []}
            >
              <KeyboardInsets />
              {standalone && <PwaRoutePersistence />}
            </AppInterface>
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
    // The boot watchdog (public/orchestra-boot.js) shows an error if the app
    // never mounts; take the loading fallback down and tell it we mounted.
    root.querySelector("[data-boot-fallback]")?.remove()
    root.dataset.opencodeRendered = ""
  }).catch((error) => {
    console.error(error)
    showStartupError(root)
  })
}

function showStartupError(root: HTMLElement) {
  const locale = getLocale()
  const title = (locale === "zh" ? zh["error.page.title"] : en["error.page.title"]) ?? en["error.page.title"]
  const description =
    (locale === "zh" ? zh["error.page.description"] : en["error.page.description"]) ??
    en["error.page.description"]
  const reloadLabel =
    (locale === "zh" ? zh["error.page.action.reload"] : en["error.page.action.reload"]) ??
    en["error.page.action.reload"]
  root.textContent = ""
  const page = document.createElement("div")
  page.style.cssText =
    "font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#222"
  const heading = document.createElement("h1")
  heading.textContent = title
  const text = document.createElement("p")
  text.textContent = description
  const reload = document.createElement("button")
  reload.textContent = reloadLabel
  reload.style.cssText = "font:inherit;padding:8px 16px;cursor:pointer"
  reload.addEventListener("click", () => location.reload())
  page.append(heading, text, reload)
  root.append(page)
}

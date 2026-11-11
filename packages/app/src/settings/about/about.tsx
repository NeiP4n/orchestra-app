import { useDialog } from "@orchestra/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ExternalLink } from "@/runtime/platform/external-link"
import { showToast } from "@/shell/notifications/toast"
import { NeuralDot } from "@orchestra/ui/neural-field"

export function SettingsAbout(_props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()

  let noticesButton: HTMLButtonElement | undefined

  const showNotices = async () => {
    // The license texts load only when someone reads them.
    const loaded = await import("./notices/dialog").catch(() => undefined)

    if (!loaded) {
      showToast({ variant: "error", title: language.t("settings.about.notices.loadFailed") })

      return
    }

    // dialog.show has no trigger for Kobalte to restore, so closing returns focus to the button by hand.
    void dialog.show(() => (
      <loaded.default
        onCloseAutoFocus={(event) => {
          if (!noticesButton?.isConnected) return
          event.preventDefault()
          noticesButton.focus({ preventScroll: true })
        }}
      />
    ))
  }

  return (
    <div class="settings-about-content">
      <div class="settings-about-intro">
        <p>
          {language.t("settings.about.version", {
            version: platform.version ?? language.t("settings.about.devVersion"),
          })}
        </p>
        <p>{language.t("settings.about.license")}</p>
      </div>

      <div class="settings-about-orchestra" data-component="orchestra-about-wordmark">
        <NeuralDot />
        <span>ORCHESTRA</span>
      </div>
      <p>{language.t("settings.about.description")}</p>
      <p>
        <ExternalLink href="https://github.com/NeiP4n/orchestra-app">github.com/NeiP4n/orchestra-app</ExternalLink>
      </p>
      <div class="settings-about-details">
        <p>
          <button ref={noticesButton} type="button" class="settings-about-link" onClick={() => void showNotices()}>
            {language.t("settings.about.notices.title")}
          </button>
        </p>
      </div>
    </div>
  )
}

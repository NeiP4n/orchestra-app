import "./index.css"
import { Title, Meta } from "@solidjs/meta"
import { Header } from "~/component/header"
import { Footer } from "~/component/footer"
import { Legal } from "~/component/legal"
import { useI18n } from "~/context/i18n"
import { LocaleLinks } from "~/component/locale-links"
import { config } from "~/config"
import logoSvg from "../../asset/logo.svg"
import logoOrnateLightSvg from "../../asset/logo-ornate-light.svg"
import logoOrnateDarkSvg from "../../asset/logo-ornate-dark.svg"

const assets = [
  { src: logoSvg, name: "orchestra-logo.svg" },
  { src: logoOrnateLightSvg, name: "orchestra-logo-light.svg" },
  { src: logoOrnateDarkSvg, name: "orchestra-logo-dark.svg" },
]

export default function Brand() {
  const i18n = useI18n()
  const alt = i18n.t("brand.meta.description")
  const downloadFile = async (url: string, filename: string) => {
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = window.URL.createObjectURL(blob)

      const link = document.createElement("a")
      link.href = blobUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      window.URL.revokeObjectURL(blobUrl)
    } catch (error) {
      console.error("Download failed:", error)
      const link = document.createElement("a")
      link.href = url
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
  }

  return (
    <main data-page="enterprise">
      <Title>{i18n.t("brand.title")}</Title>
      <LocaleLinks path="/brand" />
      <Meta name="description" content={i18n.t("brand.meta.description")} />
      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="brand-content">
            <h1>{i18n.t("brand.heading")}</h1>
            <p>{i18n.t("brand.subtitle")}</p>

            <div data-component="brand-grid">
              {assets.map((asset) => (
                <div>
                  <img src={asset.src} alt={alt} />
                  <div data-component="actions">
                    <button onClick={() => downloadFile(asset.src, asset.name)}>
                      SVG
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M13.9583 10.6247L10 14.583L6.04167 10.6247M10 2.08301V13.958M16.25 17.9163H3.75"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="square"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <p>
              <a href={config.github.repoUrl} target="_blank">
                {config.github.repoUrl}
              </a>
            </p>
          </section>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}

import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "com.nei4pn.orchestra" : `com.nei4pn.orchestra.${channel}`

const productName = channel === "prod" ? "Orchestra" : `Orchestra ${channel.charAt(0).toUpperCase() + channel.slice(1)}`

const summary = `Open source AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const bugtrackerUrl = process.env.ORCHESTRA_BUGTRACKER_URL ?? "https://github.com/NeiP4n/orchestra-app/issues"

const homepageUrl = process.env.ORCHESTRA_HOMEPAGE_URL ?? "https://github.com/NeiP4n/orchestra-app"

const vcsBrowserUrl = process.env.ORCHESTRA_VCS_URL ?? "https://github.com/NeiP4n/orchestra-app"

const screenshotUrl = process.env.ORCHESTRA_SCREENSHOT_URL

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ly.anoma">
    <name>Anomaly Innovations Inc.</name>
  </developer>

  <description>
    <p>
      OpenCode is an open source agent that helps you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">${bugtrackerUrl}</url>
  <url type="homepage">${homepageUrl}</url>
  <url type="vcs-browser">${vcsBrowserUrl}</url>${
    screenshotUrl
      ? `

  <screenshots>
    <screenshot type="default">
      <image>${screenshotUrl}</image>
    </screenshot>
  </screenshots>`
      : ""
  }
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)

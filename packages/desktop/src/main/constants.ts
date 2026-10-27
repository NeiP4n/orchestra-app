import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.ORCHESTRA_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.ORCHESTRA_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "Orchestra Dev",
  beta: "Orchestra Beta",
  prod: "Orchestra",
}

const appIDs: Record<string, string> = {
  dev: "com.nei4pn.orchestra.dev",
  beta: "com.nei4pn.orchestra.beta",
  prod: "com.nei4pn.orchestra",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "Orchestra Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "com.nei4pn.orchestra.dev"

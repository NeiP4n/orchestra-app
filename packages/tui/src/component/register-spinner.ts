import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOrchestraSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}

export const registerOpencodeSpinner = registerOrchestraSpinner

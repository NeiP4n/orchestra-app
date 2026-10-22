import type { ElectronNative } from "../preload/types"

declare global {
  interface ImportMetaEnv {
    readonly ORCHESTRA_TEST_ONBOARDING: boolean
  }

  interface Window {
    electron: ElectronNative
    __ORCHESTRA__?: {
      deepLinks?: string[]
    }
  }
}

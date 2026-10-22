interface ImportMetaEnv {
  readonly ORCHESTRA_CHANNEL: string
  readonly ORCHESTRA_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

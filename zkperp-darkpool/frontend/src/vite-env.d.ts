/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROGRAM_ID:        string
  readonly VITE_USDCX_ID:          string
  readonly VITE_NETWORK:           string
  readonly VITE_API:               string
  readonly VITE_OPERATOR_ADDRESS:  string
  readonly VITE_BATCH_BLOCKS:      string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

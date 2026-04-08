// ---------------------------------------------------------------------------
// Vite environment type augmentation.
//
// `/// <reference types="vite/client" />` makes the global ImportMeta interface
// know about `import.meta.env`. We also extend it with our own VITE_*
// variables so editors get autocomplete and tsc doesn't complain.
// ---------------------------------------------------------------------------
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Hostname of the Nakama server. No scheme, no port. */
  readonly VITE_NAKAMA_HOST?: string;
  /** Port of the Nakama HTTP API. Default 7350. */
  readonly VITE_NAKAMA_PORT?: string;
  /** "true" if the Nakama server is reachable over HTTPS / WSS. */
  readonly VITE_NAKAMA_USE_SSL?: string;
  /** Server key shared between Nakama and the client. Default "defaultkey". */
  readonly VITE_NAKAMA_SERVER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

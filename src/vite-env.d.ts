/// <reference types="vite/client" />

// Build-time deploy colophon, injected by vite.config.ts `define` (literal
// text replacement at build, not an env var). Lets the bottom-of-screen
// footer show which commit the player is on without a runtime lookup.
declare const __APP_COMMIT__: string
declare const __APP_BUILD_DATE__: string

// Cloud leaderboard API base. Empty in production (same-origin Pages Functions
// at /api/*); set VITE_API_BASE=http://localhost:8788 to point dev at a local
// `wrangler pages dev` instance. Merges into vite/client's ImportMetaEnv.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

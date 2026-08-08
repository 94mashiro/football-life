/// <reference types="vite/client" />

// Build-time deploy colophon, injected by vite.config.ts `define` (literal
// text replacement at build, not an env var). Lets the bottom-of-screen
// footer show which commit the player is on without a runtime lookup.
declare const __APP_COMMIT__: string
declare const __APP_BUILD_DATE__: string

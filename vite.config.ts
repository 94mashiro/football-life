import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'

// Base path for static assets. GitHub Pages serves user/project sites under
// /<repo>/ unless a custom domain is used, so the deploy workflow sets
// VITE_BASE=/football-life/. Default "/" for local + Vercel/Netlify (root).
const base = process.env.VITE_BASE ?? '/'

// Bake a deploy colophon into the bundle at build time: short commit hash (+
// `*` when the worktree is dirty) and the build date. Read from git so the
// same command that ships the site (npm run deploy:cf → vite build) stamps
// the exact commit the user is playing. Falls back to `dev` outside a repo.
function readCommit(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return dirty ? `${hash}*` : hash
  } catch {
    return 'dev'
  }
}
const appCommit = readCommit()
const appBuildDate = new Date().toISOString().slice(0, 10)

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  define: {
    __APP_COMMIT__: JSON.stringify(appCommit),
    __APP_BUILD_DATE__: JSON.stringify(appBuildDate),
  },
})

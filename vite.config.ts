import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Base path for static assets. GitHub Pages serves user/project sites under
// /<repo>/ unless a custom domain is used, so the deploy workflow sets
// VITE_BASE=/football-life/. Default "/" for local + Vercel/Netlify (root).
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
})

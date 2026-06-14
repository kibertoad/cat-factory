import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Lightweight unit-test setup for the Nuxt SPA. It exercises pure client logic
// (Pinia store getters, catalog utilities, composables) without booting the full
// Nuxt runtime — Nuxt auto-imports the tested modules rely on are stubbed in
// `test/setup.ts`. The `~`/`@` aliases mirror Nuxt's `app/` srcDir.
const app = fileURLToPath(new URL('./app', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '~': app, '@': app },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['app/**/*.spec.ts'],
  },
})

import { createApp } from './app'

// Cloudflare Worker entry. A Hono app is itself a `{ fetch }` handler, so the
// app instance is the default export the runtime invokes.
const app = createApp()

export default app

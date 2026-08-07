import { readFileSync } from 'node:fs'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The suite runs inside real workerd, against a Worker built from THIS package's own factory
// (`test/worker.ts`) with real bindings: a real Durable Object for the dedupe log and the minted
// keys, real WebCrypto for the delivery MAC, real Cap'n Web over a real WebSocket. That is the
// point rather than a preference: the credential-custody story IS "the key is a Worker secret held
// by the Worker", so a Node mock of a Worker would prove nothing about it. Every unit spec beside
// it runs in the same isolate, which costs nothing and keeps one runtime for the package.
//
// What is faked is the cat-factory deployment on the other side, bound as the pool's
// `outboundService` so every outbound `fetch` the SDK makes lands on it with no network. See
// `test/fake-cat-factory.mjs` for why a scripted, echoing origin is the right instrument here
// rather than a real backend.
// Relative to the package root, which is vitest's cwd (the same convention the Worker runtime's
// own config reads its D1 migrations with).
const fakeCatFactory = readFileSync('./test/fake-cat-factory.mjs', 'utf8')

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Nothing in this Worker has a remote-only binding, and a remote session would need
      // credentials the suite must never require.
      remoteBindings: false,
      wrangler: { configPath: './test/wrangler.toml' },
      miniflare: {
        outboundService: 'cat-factory',
        workers: [{ name: 'cat-factory', modules: true, script: fakeCatFactory }],
        // Every var and secret the Worker reads. They live here rather than in the suite's
        // wrangler config because three of them ARE secrets, which a deployment puts in the
        // platform's secret store and therefore never writes in a config file at all.
        bindings: {
          CAT_FACTORY_BASE_URL: 'https://cat-factory.example.com',
          PUBLIC_URL: 'https://gatekeeper.example.com',
          WEBHOOK_ID: 'gatekeeper',
          PROVISIONING_KEY: 'cf_live_pak_provisioning.provisioning-secret',
          WEBHOOK_SECRET: 'test-webhook-secret-0123456789ab',
          OS_SHARED_TOKEN: 'test-os-shared-token',
        },
      },
    }),
  ],
})

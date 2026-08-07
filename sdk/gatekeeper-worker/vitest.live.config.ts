import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The LIVE suite: the same Worker `vitest.config.ts` boots, with the scripted origin taken away.
//
// One difference from its sibling and it is the whole point: there is no `outboundService`, so the
// SDK's calls leave workerd and land on a real cat-factory deployment. That deployment is not
// booted here. `@cat-factory/sdk-smoketest` owns it (`--only=gatekeeper`), because the harness that
// boots a backend should be the one that owns the boot, and a published library should not carry a
// Postgres-shaped devDependency to be tested.
//
// Which is why every value below that names the deployment is REQUIRED from the environment rather
// than defaulted: a default would let this suite boot against nothing and report the pass that
// "zero failures" always looks like. The Gatekeeper's own secrets are constants, because they are
// this suite's to choose: the OS side and the receiver are both in the test.

/** A binding the harness must supply. A missing one is a refusal naming who supplies it. */
function fromHarness(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is not set. The live Gatekeeper suite runs against a deployment that ` +
        '`@cat-factory/sdk-smoketest` boots: run `pnpm --filter @cat-factory/sdk-smoketest run ' +
        'smoketest -- --only=gatekeeper` rather than this config directly.',
    )
  }
  return value
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      // The same Worker, the same Durable Object, the same migration tag as the hermetic suite and
      // as the template: what differs between the two runs is the origin, and nothing else.
      wrangler: { configPath: './test/wrangler.toml' },
      miniflare: {
        bindings: {
          CAT_FACTORY_BASE_URL: fromHarness('CAT_FACTORY_BASE_URL'),
          PROVISIONING_KEY: fromHarness('CAT_FACTORY_PROVISIONING_KEY'),
          // A public `https` host, because the deployment refuses to register anything else — and
          // an unroutable one, because nothing may actually arrive: the suite drives the receiver
          // itself, with the platform's own notification inside the envelope. `.invalid` never
          // resolves, so a delivery the deployment attempts fails at DNS instead of reaching a
          // host somebody else owns.
          PUBLIC_URL: 'https://gatekeeper.cat-factory.invalid',
          WEBHOOK_ID: 'gatekeeper-live-smoketest',
          WEBHOOK_SECRET: 'live-smoketest-webhook-secret-0123456789',
          OS_SHARED_TOKEN: 'live-smoketest-os-shared-token',
        },
      },
    }),
  ],
  test: {
    include: ['test/live/**/*.spec.ts'],
    // A real run reaching its first park is real work on a real engine, and the suite polls for it
    // with its own deadline. The vitest timeout only has to be the larger of the two.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // One file, one deployment, one workspace: parallel files would race each other's tasks and
    // their minted keys through the same board.
    fileParallelism: false,
  },
})

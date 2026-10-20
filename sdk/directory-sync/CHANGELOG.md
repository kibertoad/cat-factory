# @cat-factory/directory-sync

## 0.2.3

### Patch Changes

- 5c17395: Dependency refresh, direct and transitive (the lockfile is re-resolved from scratch), held to the
  24h `minimumReleaseAge` window.
  
  Majors, each taken because its whole peer group could move together:
  
  - **Vitest 5** (`vitest`, `@vitest/coverage-v8`, `@vitest/browser`, `@vitest/browser-playwright`
    at `5.0.5`), now that `@cloudflare/vitest-plugin@1.4.4`, `@storybook/addon-vitest`,
    `@nuxt/test-utils` and `vitest-browser-vue` all accept `^5`. The Worker suite turns Vitest 5's
    new default `fsModuleCache` off: the Workers pool inlines every warm module into one WebSocket
    reply, and this suite's graph (~80MB) exceeds workerd's message limit (`1009 Message is too
    large`).
  - **msw 3**, for the component stories. `onUnhandledRequest` became `onUnhandledFrame`, which
    also receives WebSocket frames, and the bundled `mockServiceWorker.js` is regenerated.
  - **happy-dom 21** for the SPA's unit tests.
  
  The Workers test pool moves to `@cloudflare/vitest-plugin@1.4.4`, which pins `wrangler@4.151.1`, so
  the Cloudflare stack moves with it: workerd `1.20261012.1`, miniflare `5.20261012.1-beta`,
  `@cloudflare/workers-types` `5.20261012.1` (the resolved workerd's date) and esbuild `0.28.2`
  (the version wrangler and the plugin now pin, so the scoped esbuild overrides follow).
  
  Also the Vercel AI SDK family as one set (`ai@7.0.142`, `@ai-sdk/anthropic@4.0.81`,
  `@ai-sdk/openai@4.0.95`, `@ai-sdk/openai-compatible@3.0.70`, `@ai-sdk/amazon-bedrock@5.0.117`,
  `@ai-sdk/provider@4.0.28`), the Vue family at `3.5.44`, `@nuxt/ui@4.12.0`, `pinia@4.1.0`,
  `storybook@10.6.2`, `undici@8.12.2`, `pg-boss@12.38.0`, `@aws-sdk/client-s3@3.1152.0`,
  `@hono/node-server@2.1.5`, `@playwright/test@1.64.1`, and the root toolchain (`turbo@2.11.8`,
  `oxlint@1.88.0`, `oxfmt@0.73.0`, `knip@6.41.0`).
  
  Held: the frontend stays on TypeScript 6 (TypeScript 7 ships no classic compiler API for
  `vue-tsc`); `@nuxt/fonts` stays on 0.14 because `@nuxt/ui@4.12.0` depends on `^0.14.0`; Drizzle
  stays on `1.0.0-rc.4`, still its `rc` tag; `nuxt@4.6.2` is inside the window.
- Updated dependencies [5c17395]
  - @cat-factory/webhooks@0.2.1

## 0.2.2

### Patch Changes

- f702a8e: `GET /api/v1/directory/reach` (`client.directory.getReach`) answers the calling key's account and
  workspace reach without an `x-cat-factory-workspace` header. `GET /api/v1/me` names one workspace,
  so it refused a key reaching several that sent no header, and that is every key a directory webhook
  accepts.
  
  `DirectorySyncer.handleDelivery` read the key's reach from `/me`, so every push to a directory
  webhook failed with `422 workspace_required`. It now reads `/api/v1/directory/reach`, and falls back
  to `/me` against a deployment without that route or with an SDK that predates `getReach`. OpenAPI
  1.88.0.

## 0.2.1

### Patch Changes

- 5d586fc: The SDK packages no longer pin each other to an exact version. A dependency on a sibling publishes as a caret range, so a consumer a patch ahead on `@cat-factory/sdk` keeps one copy of it. `@cat-factory/directory-sync` takes `@cat-factory/sdk` as a peer (`>=0.57.0 <1.0.0`): the client it drives is the integrator's own, so it now uses their copy of the SDK and installs none of its own. Add `@cat-factory/sdk` to your dependencies if you did not already have it.

## 0.2.0

### Minor Changes

- d0a7cb9: Two new packages for integrators. `@cat-factory/webhooks` verifies a signed cat-factory webhook
  delivery (`verifyDelivery`, plus `verifyRequest` for a Fetch API request), with Web Crypto only so
  it runs on Node, in a browser or in a worker isolate. `@cat-factory/directory-sync` keeps a copy of
  an account's directory in sync over a `DirectoryStore` you implement: snapshot bootstrap,
  change-feed catch-up with a fallback to reconciliation on `cursor_expired`, verified webhook pushes,
  and a full reconciliation that deletes what the source dropped. `@cat-factory/gatekeeper-worker`
  now re-exports its delivery verifier from `@cat-factory/webhooks`; its public surface is unchanged.

### Patch Changes

- Updated dependencies [04c1587]
- Updated dependencies [f1b6c9a]
- Updated dependencies [d0a7cb9]
- Updated dependencies [20d4f01]
  - @cat-factory/sdk@0.57.0
  - @cat-factory/webhooks@0.2.0

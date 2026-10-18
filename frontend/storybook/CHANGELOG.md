# @cat-factory/storybook

## 0.0.7

### Patch Changes

- Updated dependencies [e318526]
  - @cat-factory/app@0.321.1

## 0.0.6

### Patch Changes

- Updated dependencies [162a89b]
  - @cat-factory/app@0.321.0

## 0.0.5

### Patch Changes

- 6a3500f: Pause the story lane's nightly and per-PR runs until #2442 restores them. It still runs on manual dispatch.
- Updated dependencies [3438f7f]
  - @cat-factory/app@0.320.1

## 0.0.4

### Patch Changes

- 335b599: Cap the story lane at 3 workers, the count Vitest gives CI's 4-vCPU runner. Without a cap, Vitest
  opened one Chromium page per core but one (at most 12), which held the whole CPU on a large machine.
  Pass `--maxWorkers` to override it.
- c794c57: Bump `@storybook-vue/nuxt` to `10.0.2`, which ships the Nuxt 4.6 app-context fix
  (nuxt-modules/storybook#1139). The local pnpm patch now carries only the fix for the empty canvas
  id under `@storybook/addon-vitest` (nuxt-modules/storybook#1140).

## 0.0.3

### Patch Changes

- Updated dependencies [afe22b9]
  - @cat-factory/app@0.320.0

## 0.0.2

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
  - @cat-factory/app@0.319.2

## 0.0.1

### Patch Changes

- Updated dependencies [76176b8]
  - @cat-factory/app@0.319.1

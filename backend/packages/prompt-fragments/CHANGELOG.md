# @cat-factory/prompt-fragments

## 1.1.75

### Patch Changes

- Updated dependencies [09ccd89]
- Updated dependencies [31f32a1]
  - @cat-factory/contracts@0.376.0
  - @cat-factory/kernel@0.363.2

## 1.1.74

### Patch Changes

- Updated dependencies [dff3a0d]
- Updated dependencies [fa0ba67]
- Updated dependencies [6220716]
  - @cat-factory/contracts@0.375.0
  - @cat-factory/kernel@0.363.1

## 1.1.73

### Patch Changes

- Updated dependencies [e9b24a1]
  - @cat-factory/kernel@0.363.0
  - @cat-factory/contracts@0.374.0

## 1.1.72

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
- Updated dependencies [5c17395]
  - @cat-factory/kernel@0.362.0
  - @cat-factory/contracts@0.373.1

## 1.1.71

### Patch Changes

- Updated dependencies [83f6b0c]
  - @cat-factory/contracts@0.373.0
  - @cat-factory/kernel@0.361.0

## 1.1.70

### Patch Changes

- Updated dependencies [f702a8e]
  - @cat-factory/contracts@0.372.0
  - @cat-factory/kernel@0.360.4

## 1.1.69

### Patch Changes

- Updated dependencies [b3a13d3]
  - @cat-factory/contracts@0.371.0
  - @cat-factory/kernel@0.360.3

## 1.1.68

### Patch Changes

- Updated dependencies [6f574e9]
  - @cat-factory/contracts@0.370.0
  - @cat-factory/kernel@0.360.2

## 1.1.67

### Patch Changes

- Updated dependencies [96e7e3d]
  - @cat-factory/contracts@0.369.0
  - @cat-factory/kernel@0.360.1

## 1.1.66

### Patch Changes

- Updated dependencies [58b57cc]
  - @cat-factory/contracts@0.368.0
  - @cat-factory/kernel@0.360.0

## 1.1.65

### Patch Changes

- Updated dependencies [918e977]
  - @cat-factory/contracts@0.367.0
  - @cat-factory/kernel@0.359.1

## 1.1.64

### Patch Changes

- Updated dependencies [04c1587]
- Updated dependencies [f1b6c9a]
- Updated dependencies [20d4f01]
  - @cat-factory/contracts@0.366.0
  - @cat-factory/kernel@0.359.0

## 1.1.63

### Patch Changes

- Updated dependencies [91dedb6]
  - @cat-factory/contracts@0.365.0
  - @cat-factory/kernel@0.358.1

## 1.1.62

### Patch Changes

- Updated dependencies [5ec1794]
  - @cat-factory/contracts@0.364.0
  - @cat-factory/kernel@0.358.0

## 1.1.61

### Patch Changes

- Updated dependencies [1a42f34]
  - @cat-factory/kernel@0.357.1

## 1.1.60

### Patch Changes

- Updated dependencies [e3c4b3c]
  - @cat-factory/contracts@0.363.0
  - @cat-factory/kernel@0.357.0

## 1.1.59

### Patch Changes

- Updated dependencies [ffe4356]
- Updated dependencies [ffe4356]
  - @cat-factory/kernel@0.356.0

## 1.1.58

### Patch Changes

- Updated dependencies [97175f8]
  - @cat-factory/contracts@0.362.0
  - @cat-factory/kernel@0.355.0

## 1.1.57

### Patch Changes

- Updated dependencies [a3a10b8]
- Updated dependencies [0966666]
  - @cat-factory/contracts@0.361.0
  - @cat-factory/kernel@0.354.2

## 1.1.56

### Patch Changes

- Updated dependencies [8766c3f]
  - @cat-factory/contracts@0.360.0
  - @cat-factory/kernel@0.354.1

## 1.1.55

### Patch Changes

- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
  - @cat-factory/contracts@0.359.0
  - @cat-factory/kernel@0.354.0

## 1.1.54

### Patch Changes

- Updated dependencies [075ff13]
  - @cat-factory/contracts@0.358.0
  - @cat-factory/kernel@0.353.0

## 1.1.53

### Patch Changes

- Updated dependencies [57d9db3]
  - @cat-factory/kernel@0.352.0
  - @cat-factory/contracts@0.357.0

## 1.1.52

### Patch Changes

- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
  - @cat-factory/kernel@0.351.0

## 1.1.51

### Patch Changes

- Updated dependencies [c046707]
- Updated dependencies [c046707]
  - @cat-factory/kernel@0.350.0

## 1.1.50

### Patch Changes

- Updated dependencies [1fc4ff1]
- Updated dependencies [bc073ab]
- Updated dependencies [09bd94b]
  - @cat-factory/contracts@0.356.0
  - @cat-factory/kernel@0.349.0

## 1.1.49

### Patch Changes

- Updated dependencies [30d08c7]
  - @cat-factory/kernel@0.348.1

## 1.1.48

### Patch Changes

- Updated dependencies [9f8cabc]
  - @cat-factory/contracts@0.355.1
  - @cat-factory/kernel@0.348.0

## 1.1.47

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/contracts@0.355.0
  - @cat-factory/kernel@0.347.0

## 1.1.46

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/contracts@0.354.0
  - @cat-factory/kernel@0.346.2

## 1.1.45

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/contracts@0.353.0
  - @cat-factory/kernel@0.346.1

## 1.1.44

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0

## 1.1.43

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0

## 1.1.42

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0

## 1.1.41

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/kernel@0.343.1

## 1.1.40

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0

## 1.1.39

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/kernel@0.342.1

## 1.1.38

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0

## 1.1.37

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0

## 1.1.36

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0

## 1.1.35

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0

## 1.1.34

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0

## 1.1.33

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0

## 1.1.32

### Patch Changes

- 5c50d30: Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
  wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
  from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
  folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
  per-row busy guard), and removes tests that asserted a constant against its own literal or
  re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.
  
  Internal-surface break, flagged per the compatibility rules: the removed barrel exports
  (`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
  `SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
  the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
  schema aliases) had no consumer in this repository; a downstream import of one of them fails at
  typecheck and should read the underlying helper directly.
- Updated dependencies [5c50d30]
  - @cat-factory/contracts@0.346.2
  - @cat-factory/kernel@0.336.1

## 1.1.31

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/kernel@0.336.0

## 1.1.30

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 1.1.29

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 1.1.28

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 1.1.27

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 1.1.26

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 1.1.25

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 1.1.24

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 1.1.23

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 1.1.22

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 1.1.21

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 1.1.20

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 1.1.19

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 1.1.18

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 1.1.17

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 1.1.16

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

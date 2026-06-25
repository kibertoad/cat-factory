# @cat-factory/provider-bedrock

## 0.7.11

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1

## 0.7.10

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0

## 0.7.9

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/kernel@0.11.1

## 0.7.8

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/kernel@0.11.0
  - @cat-factory/agents@0.10.0

## 0.7.7

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/agents@0.9.0
  - @cat-factory/kernel@0.10.1

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/kernel@0.10.0
  - @cat-factory/agents@0.8.2

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/kernel@0.8.0

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/agents@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/kernel@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/kernel@0.7.1

## 0.7.0

### Minor Changes

- 8eed38c: Introduce a generic, extensible AI provisioning facade so model resolution is no
  longer hardwired to the Cloudflare Worker.

  `@cat-factory/agents` now exposes `CompositeModelProvider` — a `ModelProvider`
  composed from one or more mixable `ProviderRegistry` maps — plus the base,
  runtime-neutral resolvers (`openAiResolver`, `anthropicResolver`,
  `openAiCompatibleResolver`, `cloudflareRestResolver`, `baseProviderRegistry`) and
  the shared OpenAI-compatible endpoint constants. Direct vendor usage works on any
  runtime; `cloudflareRestResolver` adds a non-binding path to Cloudflare-hosted
  models (Workers AI REST / AI Gateway) for non-Worker deployments.

  AWS Bedrock support ships as a separate opt-in package,
  `@cat-factory/provider-bedrock` (`bedrockResolver` / `bedrockRegistry`), so the
  AWS SDK is pulled in only by deployments that use it. It throws a clear
  `Unsupported Bedrock model` for any model id outside its configured allow-list.

  `@cat-factory/worker`'s `CloudflareModelProvider` is now a thin composition of the
  shared facade (behaviour unchanged: same providers, same "not configured" errors),
  and a new installation extension point — `registerModelRegistry` — lets a
  deployment mix extra provider registries (e.g. Bedrock) into every container build,
  including the durable Workflow and cron-sweeper paths.

### Patch Changes

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [8eed95b]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0

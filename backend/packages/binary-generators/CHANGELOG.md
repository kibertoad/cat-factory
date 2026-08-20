# @cat-factory/binary-generators

## 0.3.3

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0

## 0.3.2

### Patch Changes

- 3db0d43: Refresh the whole dependency tree, re-roll both runner images, and move the three bundled agent CLIs.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.64 → ^7.0.68`,
    `@ai-sdk/anthropic@^4.0.38 → ^4.0.39`, `@ai-sdk/openai@^4.0.41 → ^4.0.43`,
    `@ai-sdk/openai-compatible@^3.0.30 → ^3.0.31`, `@ai-sdk/amazon-bedrock@^5.0.55 → ^5.0.58`.
  - **Runtime deps**: `hono@^4.13.1 → ^4.13.3`, `@hono/node-server@^2.1.0 → ^2.1.1`,
    `jose@^6.2.8 → ^6.2.9`, `capnweb@^0.11.0 → ^0.11.1`, `@aws-sdk/client-s3@^3.1109.0 → ^3.1113.0`.
  - **Tooling**: `wrangler@^4.122.0 → ^4.124.0`,
    `@cloudflare/workers-types@^5.20260812.1 → ^5.20260819.1` (which is what wrangler 4.124 now
    peer-requires), `@cloudflare/vitest-pool-workers@^0.21.2 → ^0.22.0`, `vitest@^4.1.10 → ^4.1.11`,
    `@vitest/coverage-v8@^4.1.10 → ^4.1.11`, `oxlint@^1.78.0 → ^1.79.0`, `oxfmt@^0.63.0 → ^0.64.0`,
    `publint@^0.3.23 → ^0.3.24`, `turbo@^2.10.9 → ^2.10.11`, `vue-tsc@^3.3.9 → ^3.3.10`,
    `@types/pg@^8.21.0 → ^8.23.1`, pnpm `11.21.0 → 11.22.0`.

  **The three agent CLIs the executor image bundles** move together: Pi `0.84.1 → 0.84.2`, Codex
  `0.147.0 → 0.148.0`, Claude Code `2.1.231 → 2.1.237`. The Claude Code pin is taken at its newest
  release, ahead of the 24h `minimumReleaseAge` window, which is the explicit call that pin's own note
  asks to re-make on every bump. Pi's two extensions move in lockstep as their monorepo publishes
  them, `2.4.0 → 2.6.2`.

  **The UI-tester image** aligns its Playwright with the one the e2e suite drives (`1.61.1 → 1.62.1`),
  and moves `@yarnpkg/cli-dist@4.10.3 → 4.18.0` and `serve@14.2.5 → 14.2.6`. **The deploy image** takes
  `kubectl v1.36.3 → v1.36.4` and `helm v4.2.3 → v4.2.4`; kustomize is already current at `v5.8.1`.

  Both image tags therefore move in this change (`cat-factory-executor:1.127.0`,
  `cat-factory-executor-ui:1.127.0`, `cat-factory-deploy:0.2.14`): republishing over a live tag does
  not roll a deployment out.

  No `minimumReleaseAgeExclude` entries were added and none were needed: every registry bump above
  already clears the gate. Five packages had a newer release the gate still withholds
  (`@ai-sdk/*`, `ai@7.0.70`, `happy-dom@20.11.6`, `@aws-sdk/client-s3@3.1114.0`,
  `@cloudflare/workers-types@5.20260820.1`), so each lands one release short of the registry's head.
  `drizzle-orm`/`drizzle-kit` stay on `1.0.0-rc.4`: the only newer builds are commit-suffixed
  snapshots, not a released `rc.5`. Majors available but deliberately not taken here, each being its
  own change: `@changesets/cli@3`, `@stryker-mutator/*@10`, and TypeScript 7 for the two frontend
  packages still on 6.

- Updated dependencies [3db0d43]
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1

## 0.3.1

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0

## 0.3.0

### Minor Changes

- 5b281a3: Act on the first external-API sweep: three vendor surfaces had already moved, two more carry
  announced dates, and eight had drifted.

  **Broken.** Confluence page reads move to Cloud REST v2 (`GET /wiki/api/v2/pages/{id}`); the v1
  content endpoint they targeted was retired on 2025-04-30, and CQL search stays on v1 because v2
  publishes no search endpoint. incident.io enrichment posts to `POST /v2/actions`, an endpoint that
  exists, where `POST /v2/incident_updates` never has at any version: the investigation lands as an
  unassigned action on the live incident rather than a status-page update (which would re-alert
  customers) or a follow-up (which is post-incident work). The MCP tool-server probe is now dual-era:
  revision `2026-07-28` deleted the `initialize` handshake, `notifications/initialized` and
  protocol-level sessions, so the probe opens in the modern stateless dialect and falls back to the
  handshake on a refusal that is not one of the three MCP-reserved error codes, or on any refusal
  naming a handshake-era revision. `server/discover`'s `supportedVersions` is negotiated onto rather
  than read and discarded, and the HTTP status is read before the body, so a 401 answered in JSON
  (the ordinary shape for an OAuth-protected server) is one refusal rather than two.

  **Dated.** The Langfuse sink is now the OTLP exporter pointed at Langfuse's OpenTelemetry endpoint;
  the batch ingestion API it used to speak is deprecated, sunsets on Langfuse Cloud on 2026-11-16, and
  its three event types are already unsupported on the v4 data model.

  **Drift.** Google userinfo reads from `openidconnect.googleapis.com/v1/userinfo`, the host Google's
  own discovery document publishes. Datadog monitor reads ask for `group_states=all` and fold
  `state.groups[*].last_triggered_ts` over the groups that are STILL ALERTING, so the
  post-release-health gate can once again tell a standing alert from one this release caused; the
  field it used to read is not in Datadog's schema, so the transition time was silently always
  absent, and the per-group timestamp outlives the group recovering, so folding it over every group
  would hand a week-old standing alert to whatever release a since-cleared blip landed after. Figma OAuth refreshes at `/v1/oauth/token`, which
  superseded `/v1/oauth/refresh`. The MCP authorization-server discovery walk drops an undocumented
  location, adds the OpenID Connect path-insert one, and enforces RFC 8414's issuer-equality check
  against a DECLARED issuer: in the origin fallback there is no published identifier to compare
  against, so the equality would refuse every deployment whose authorization server identifies as a
  fronted IdP or a tenant path. Linear rate limits are read off the error `code`, because Linear
  answers an exhausted quota with HTTP 400, and a setup check reports one as the new `rate_limited`
  verdict: the key is valid and the fix is to wait, which neither `auth_failed` nor a generic error
  says. The OTLP exporter reads `partialSuccess` instead of treating any 200 as full acceptance.
  GitLab 413s carry their own remedy. The Gemini image contract narrows `thinking_level` to the two
  values that exist, states the per-model reference-image split, and declares the 401 an invalid key
  really returns. The DeepSeek base URL drops an undocumented `/v1`.

  **Additive on the wire:** a task source's setup check can answer `rate_limited`, an eighth verdict
  in `taskSourceDiagnosticStatusSchema`.

  **Breaking for an embedder:** kernel's `GateContext` and `JudgeContext` now carry a required
  `logger`. Both are built by the engine (`makeGateContext`) and by `stubGateContext` /
  `stubJudgeContext` in tests, so a registered gate or judge needs no change.

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0

## 0.2.7

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 0.2.6

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.2.5

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 0.2.4

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 0.2.3

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.2.2

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.2.1

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.2.0

### Minor Changes

- 053aac8: Ship Nano Banana as the platform's first generative binary integration, and hook the built-in Media
  pipeline to it.

  `@cat-factory/binary-generators` is a new package holding the definition (Google's Gemini image
  models, with the OpenAPI contract a run's agent reads) and `defineBinaryGenerator`, the authoring
  seam a deployment writes its own integrations with. It runs the platform's OWN registration rules at
  import, now shared from kernel (`binaryGeneratorDetailIssues`, `binaryGeneratorInjectionCollisions`)
  rather than reachable only inside orchestration's boot validator.

  Every facade now defaults `binaryGeneratorRegistry` to `binaryGeneratorRegistryWithBuiltins()`, and
  the shipped `pl_media` preset selects `nano-banana`, so a Media task generates images once
  `GEMINI_API_KEY` is set as a capability credential and nothing else is configured.

  **For a deployment that injects its own `binaryGeneratorRegistry`**: an injected instance replaces
  the shipped set rather than merging with it, so `pl_media` would then select an id nothing answers
  to and its runs are refused at admission (`binary_output_generator_invalid`). Start from
  `binaryGeneratorRegistryWithBuiltins()` and register onto that instance, or edit the preset's step.

  On the **Worker**, an injected registry is now registered process-wide by `createApp`, which is what
  carries it to the entry points that take no options. A binary-output step's dispatch brief is
  composed by the durable driver, so before this a deployment's own integrations were absent from
  every brief it built while the platform's shipped one was present.

  `PLATFORM_FOUNDATIONAL_SERVICES` is a new kernel export: the frozen definitions
  `defaultFoundationalServiceRegistry()` seeds from, shared across registries rather than copied per
  one. A caller can now tell the platform's own service from a deployment's replacement of the same
  id, which is what the local facade's mothership boot warnings need. Both of them (the estate and the
  generative integrations) report only what the deployment registered, and report a shipped id a
  deployment REPLACED, which subtracting by id could not see.

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

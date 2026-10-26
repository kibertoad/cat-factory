# @cat-factory/workspaces

## 0.31.2

### Patch Changes

- Updated dependencies [09ccd89]
- Updated dependencies [31f32a1]
  - @cat-factory/contracts@0.376.0
  - @cat-factory/kernel@0.363.2

## 0.31.1

### Patch Changes

- Updated dependencies [dff3a0d]
- Updated dependencies [fa0ba67]
- Updated dependencies [6220716]
  - @cat-factory/contracts@0.375.0
  - @cat-factory/kernel@0.363.1

## 0.31.0

### Minor Changes

- e9b24a1: A runner pool can now be set once per ACCOUNT, and every board of the account that has no pool of
  its own dispatches to it. A deployment declares it with `seedAccountRunnerPool` on the Node
  `start()`: a callback `(account) => { config, secrets } | undefined`, called for personal and org
  accounts alike. The server inserts the result for each account that has none, at boot and when a
  board is created. At boot it also replaces an account's pool when the callback's answer differs from
  the stored one (config, or the decrypted secrets), so a rotated token reaches every account on the
  next boot; board creation never replaces. On stock Node, where a runner pool is the only
  executor, a new board then runs an agent with no Infrastructure step. A legacy board with no account
  gets nothing.
  
  A board resolves its pool through one resolver: its own live row, then its account's row, then none.
  The new workspace setting `inheritAccountRunnerPool` (default `true`) is the explicit "none" marker.
  `DELETE /workspaces/:id/runner-pool/connection` now sets it to `false` unless the call carries
  `fallBackToAccount=true`, so removing a board's own pool no longer silently re-routes its work to the
  account's pool. The query parameter and the setting are additive.
  
  The seed is validated like an admin registration (backend kind registered, URL safe, referenced
  secrets present) through a shared `RunnerPoolConnectionService.validate`. A seed that fails is logged
  at `error` naming the account on every boot, and a failed read never fails board creation.
  
  New storage, mirrored on both runtimes: the `account_runner_pools` table (D1 migration 0110 and a
  Drizzle migration) with an `AccountRunnerPoolRepository` kernel port (`insertIfAbsent`, and
  `replace` for a changed seed), a unique key making the insert race safe, `AccountRepository.listAll`, and the `inherit_account_runner_pool` settings column. The
  account repository is on the mothership allow-list for reads; mothership nodes and `startLocal()` do
  not seed. The Worker does not take the option: there a pool is an optional target beside the built-in
  containers.

### Patch Changes

- Updated dependencies [e9b24a1]
  - @cat-factory/kernel@0.363.0
  - @cat-factory/contracts@0.374.0

## 0.30.8

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

## 0.30.7

### Patch Changes

- Updated dependencies [83f6b0c]
  - @cat-factory/contracts@0.373.0
  - @cat-factory/kernel@0.361.0

## 0.30.6

### Patch Changes

- Updated dependencies [f702a8e]
  - @cat-factory/contracts@0.372.0
  - @cat-factory/kernel@0.360.4

## 0.30.5

### Patch Changes

- Updated dependencies [b3a13d3]
  - @cat-factory/contracts@0.371.0
  - @cat-factory/kernel@0.360.3

## 0.30.4

### Patch Changes

- Updated dependencies [6f574e9]
  - @cat-factory/contracts@0.370.0
  - @cat-factory/kernel@0.360.2

## 0.30.3

### Patch Changes

- Updated dependencies [96e7e3d]
  - @cat-factory/contracts@0.369.0
  - @cat-factory/kernel@0.360.1

## 0.30.2

### Patch Changes

- Updated dependencies [58b57cc]
  - @cat-factory/contracts@0.368.0
  - @cat-factory/kernel@0.360.0

## 0.30.1

### Patch Changes

- Updated dependencies [918e977]
  - @cat-factory/contracts@0.367.0
  - @cat-factory/kernel@0.359.1

## 0.30.0

### Minor Changes

- 04c1587: Public-API keys belong to an account and reach every workspace in it or a chosen list. A
  workspace-scoped `/api/v1` call names its workspace in the `x-cat-factory-workspace` header, which a
  key reaching one workspace may omit, so every existing key keeps working unchanged. `PublicApiKey`
  and `GET /api/v1/me` gain `workspaceIds`; both mint bodies accept it. Widening a key past the board
  it is minted from takes an account admin, and a key can never mint or revoke one reaching further
  than itself. The header is on the CORS allow-list, so a browser client can send it. The four SDK
  clients take a workspace option. OpenAPI 1.80.0.
  
  Storage break (internal): `public_api_keys.workspace_id` is replaced by `all_workspaces` plus the
  `public_api_key_workspaces` grant table (D1 `0108`, Drizzle `20261009143721` and `20261009143724`),
  backfilled from the old column. The account cap is 200 live keys, where it was 50 per workspace,
  and a key left with no workspace after its boards were deleted holds no slot.
- f1b6c9a: `/api/v1/directory/*`: an account's workspaces, users, account memberships, workspace memberships
  and linked repositories as keyset-paged snapshots, plus an ordered change feed whose changes carry
  each entity's current state (or `null` once it is gone), for an integration keeping its own copy in
  sync. A feed cursor older than the new `DIRECTORY_CHANGE_RETENTION_DAYS` (default 30) is refused
  with the new `cursor_expired` conflict reason. OpenAPI 1.81.0.
  
  Internal: the change-row mapping both facades share moves to kernel's `directoryChangeFromRow`.
  The slice 1 `DirectoryChangeRepository` port becomes `DirectoryRepository` and joins
  `CoreDependencies` as a required member, with its reads on the mothership allow-list.
- 20d4f01: Directory webhooks: `/api/v1/directory/webhooks` registers account-level endpoints that the
  directory change feed is pushed to every couple of minutes, signed like the notification webhooks.
  Each push is a `directory.changed` page of hydrated changes, or `directory.resync_required` for an
  endpoint that fell behind the feed's retention. Delivery is a sweep on both facades (the Worker's
  frequent cron, a Node timer) that takes a per-endpoint lease before a push and moves the endpoint's
  position only after the push succeeds, so pushes are at-least-once, arrive in feed order, and are
  never doubled by concurrent sweepers; a lease whose sweeper died expires and the page is sent again. The spec gains an OpenAPI 3.1 `webhooks` section naming every push body, so
  `DirectoryWebhookDelivery`, `NotificationWebhookDelivery`, `RunWebhookDelivery` and
  `PlatformAlertWebhookDelivery` become generated types in every client.
  OpenAPI 1.82.0. New migrations: D1 `0109_directory_webhooks.sql`, Drizzle
  `20261010113115_directory_webhooks`.

### Patch Changes

- Updated dependencies [04c1587]
- Updated dependencies [f1b6c9a]
- Updated dependencies [20d4f01]
  - @cat-factory/contracts@0.366.0
  - @cat-factory/kernel@0.359.0

## 0.29.24

### Patch Changes

- Updated dependencies [91dedb6]
  - @cat-factory/contracts@0.365.0
  - @cat-factory/kernel@0.358.1

## 0.29.23

### Patch Changes

- Updated dependencies [5ec1794]
  - @cat-factory/contracts@0.364.0
  - @cat-factory/kernel@0.358.0

## 0.29.22

### Patch Changes

- Updated dependencies [1a42f34]
  - @cat-factory/kernel@0.357.1

## 0.29.21

### Patch Changes

- Updated dependencies [e3c4b3c]
  - @cat-factory/contracts@0.363.0
  - @cat-factory/kernel@0.357.0

## 0.29.20

### Patch Changes

- Updated dependencies [ffe4356]
- Updated dependencies [ffe4356]
  - @cat-factory/kernel@0.356.0

## 0.29.19

### Patch Changes

- Updated dependencies [97175f8]
  - @cat-factory/contracts@0.362.0
  - @cat-factory/kernel@0.355.0

## 0.29.18

### Patch Changes

- Updated dependencies [a3a10b8]
- Updated dependencies [0966666]
  - @cat-factory/contracts@0.361.0
  - @cat-factory/kernel@0.354.2

## 0.29.17

### Patch Changes

- Updated dependencies [8766c3f]
  - @cat-factory/contracts@0.360.0
  - @cat-factory/kernel@0.354.1

## 0.29.16

### Patch Changes

- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
  - @cat-factory/contracts@0.359.0
  - @cat-factory/kernel@0.354.0

## 0.29.15

### Patch Changes

- Updated dependencies [075ff13]
  - @cat-factory/contracts@0.358.0
  - @cat-factory/kernel@0.353.0

## 0.29.14

### Patch Changes

- Updated dependencies [57d9db3]
  - @cat-factory/kernel@0.352.0
  - @cat-factory/contracts@0.357.0

## 0.29.13

### Patch Changes

- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
  - @cat-factory/kernel@0.351.0

## 0.29.12

### Patch Changes

- Updated dependencies [c046707]
- Updated dependencies [c046707]
  - @cat-factory/kernel@0.350.0

## 0.29.11

### Patch Changes

- Updated dependencies [1fc4ff1]
- Updated dependencies [bc073ab]
- Updated dependencies [09bd94b]
  - @cat-factory/contracts@0.356.0
  - @cat-factory/kernel@0.349.0

## 0.29.10

### Patch Changes

- Updated dependencies [30d08c7]
  - @cat-factory/kernel@0.348.1

## 0.29.9

### Patch Changes

- Updated dependencies [9f8cabc]
  - @cat-factory/contracts@0.355.1
  - @cat-factory/kernel@0.348.0

## 0.29.8

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/contracts@0.355.0
  - @cat-factory/kernel@0.347.0

## 0.29.7

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/contracts@0.354.0
  - @cat-factory/kernel@0.346.2

## 0.29.6

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/contracts@0.353.0
  - @cat-factory/kernel@0.346.1

## 0.29.5

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0

## 0.29.4

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0

## 0.29.3

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0

## 0.29.2

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/kernel@0.343.1

## 0.29.1

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0

## 0.29.0

### Minor Changes

- 6ff632f: Add the in-app assistant: type what you want done, and the platform does it
  
  Everything on the board is reachable, and reaching it means knowing which panel holds it. Putting a
  repository on the board is a modal behind a sidebar entry; filing a task from a ticket is a second
  modal plus a source picker plus a container picker; declaring that one service depends on another is
  a field in a frame's inspector most people never open. Each is several clicks from someone who
  already knows the sentence they would say.
  
  The assistant takes the sentence. It ships with three actions, the ones a request most often is:
  declare that one service depends on another (so both are spun up when either is tested), add a
  service backed by a GitHub or GitLab repository named by its URL, and file a board task from an issue
  URL (GitHub, GitLab, Jira, Linear).
  
  The design decision worth reviewing is that the model does not act. It reads the request, names one
  action from a closed catalog and copies that action's arguments out of the words in front of it;
  everything after that is deterministic. The platform looks the id up in the catalog it rendered,
  validates the arguments through the shared descriptor validator, resolves every name against the
  board itself, and performs the action through the same service the equivalent button calls. So a
  hallucinated action id is a decline, an invented argument key is a dropped key, and a service name
  matching nothing (or matching two) is a question with the candidates attached. Nothing the model
  writes reaches a side effect, a stored row, or the screen.
  
  That last part is also why a turn answers with DATA rather than a chat message: the outcome variant
  carries the ids and titles of what was touched, or the machine-readable reason it could not act, and
  every sentence a person reads is rendered by the SPA from the i18n catalog. Putting the model's own
  explanation on the wire would have made the surface untranslatable and put unreviewed model text on
  screen.
  
  A QUESTION is answered as data too. A turn that could not resolve an argument carries the action it
  was heading for and the arguments it did resolve, so clicking one of the candidates re-runs that
  action with the chosen value in the field the platform named: no model call, nothing billed, and no
  chance of the answer routing somewhere else. The rule that comes with it binds any action added
  later: a candidate has to be a legal VALUE for the field the question names, or the person is being
  offered an answer the next turn refuses.
  
  `BoardService.addServiceFromRepo` now answers with the frame AND the disposition that produced it
  (`created` or `mounted`), an internal signature change with no wire effect. The account-wide dedupe
  answers with a frame either way, and only the operation knows which path it took: a caller comparing
  the returned frame against the board it read a moment ago sees a service homed on another board as a
  fresh import, which is the one case the distinction exists to report.
  
  Two alternatives were considered and rejected. A TOOL-CALLING loop (let the model call the board's
  own methods) would have put the model inside the write path, where a wrong argument is a wrong write
  rather than a wrong question, and would have made "which service did you mean?" unanswerable without
  a second round trip. A DEPLOYMENT-REGISTERED action catalog was left for a later step: every action
  performs a board write through an engine-internal service, the same reading that keeps the `merger`
  step resolver a privileged built-in, so opening the catalog means defining a public, minimal action
  context first. The tracker holds it as a named phase.
  
  Worth watching when reviewing:
  
  - The assistant is member tier and mounts no permission gate, on the same reading as the bug hunt:
    every action it performs is board authoring a member can already do from a button. Each write
    carries the asker's own tier (`blockEditAuthority`), so it is never a way around a policy its user
    is held to.
  - A turn is a billable model call no run start gates, so it answers to the workspace budget
    (`isOverBudget`) before any vendor is reached, and fails closed.
  - `WorkspaceService.snapshot` was refactored (no behaviour change) so that its board composition and
    the two visibility passes are one private method, and a new `boardBlocks` read shares them. That
    keeps exactly one definition of what is on a board while letting a caller that needs only the
    frames skip the workspace's pipelines, executions and three built-in catalogs.
  - There is no conformance group, and the reason is in the doc rather than an omission: the module is
    composed in `createCore` from dependencies every facade already provides, with no port
    implementation, table, migration or cron of its own. Making an end-to-end turn assertable per
    facade needs an `AssistantRouter` seam first, which is on the tracker.

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/kernel@0.342.1

## 0.28.64

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0

## 0.28.63

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0

## 0.28.62

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0

## 0.28.61

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0

## 0.28.60

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0

## 0.28.59

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0

## 0.28.58

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

## 0.28.57

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/kernel@0.336.0

## 0.28.56

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 0.28.55

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 0.28.54

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 0.28.53

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 0.28.52

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 0.28.51

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.28.50

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 0.28.49

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.28.48

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.28.47

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.28.46

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 0.28.45

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.28.44

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 0.28.43

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.28.42

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

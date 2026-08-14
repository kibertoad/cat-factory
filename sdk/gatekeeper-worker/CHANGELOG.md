# @cat-factory/gatekeeper-worker

## 0.6.19

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/sdk@0.43.0
  - @cat-factory/gatekeeper-bindings@0.25.0

## 0.6.18

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/sdk@0.42.0
  - @cat-factory/gatekeeper-bindings@0.24.0

## 0.6.17

### Patch Changes

- d5c1f1c: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.64`,
  `@ai-sdk/openai@4.0.41`, `@ai-sdk/amazon-bedrock@5.0.55`). The Cloudflare toolchain moves
  together again: `wrangler@4.122.0` and `@cloudflare/vitest-pool-workers@0.21.2`, whose bundled
  wrangler tracks it. `@aws-sdk/client-s3` goes to 3.1109.0 and the SPA's store engine to
  `pinia@4.0.3` / `@pinia/nuxt@1.0.2`.

  `capnweb` moves 0.10.0 to 0.11.0 in the Gatekeeper Worker. The release is additive (stubs as
  stream chunks, exact ArrayBuffer/DataView serialization, URL over RPC) and touches neither
  `RpcTarget` nor `newWorkersRpcResponse`, the only two symbols we import. Its 0.11.1 patch, which
  enforces an ASCII-only dist bundle so a consumer's `btoa()` cannot choke on the runtime, missed
  the release-age window by two hours and is the first thing the next sweep should pick up.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

  - @cat-factory/sdk@0.41.0

## 0.6.16

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/sdk@0.41.0
  - @cat-factory/gatekeeper-bindings@0.23.0

## 0.6.15

### Patch Changes

- 792ecde: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.62`,
  `@ai-sdk/anthropic@4.0.38` / `openai@4.0.40` / `openai-compatible@3.0.30` /
  `amazon-bedrock@5.0.54`). The Cloudflare toolchain moves together: `wrangler@4.121.0`,
  `@cloudflare/workers-types@5.20260812.1` and `@cloudflare/vitest-pool-workers@0.21.1`, whose only
  change over 0.20.3 is the wrangler and miniflare it bundles, so the pool now carries the same
  wrangler the workspace declares instead of one release behind it.

  `esbuild` gains three scoped `pnpm-workspace.yaml` overrides pinning vite's, tsx's and nitropack's
  loose ranges to the 0.28.1 that wrangler and `@cloudflare/vitest-pool-workers` pin exactly. Without
  them a re-resolve hands vite's optional PEER slot the newer 0.28.2 and the tree gains a second
  esbuild; because pnpm resolves an auto-installed peer without its own `optionalDependencies`, that
  copy never gets its platform binary and esbuild's postinstall aborts the entire install. The
  overrides are deliberately scoped rather than top-level: `drizzle-kit`, `@intlify/bundle-utils` and
  `fontless` declare narrower ranges that a blanket pin would force them out of.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

## 0.6.14

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/sdk@0.40.0
  - @cat-factory/gatekeeper-bindings@0.22.0

## 0.6.13

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/sdk@0.39.0
  - @cat-factory/gatekeeper-bindings@0.21.0

## 0.6.12

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/sdk@0.38.0
  - @cat-factory/gatekeeper-bindings@0.20.0

## 0.6.11

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/sdk@0.37.0
  - @cat-factory/gatekeeper-bindings@0.19.0

## 0.6.10

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/sdk@0.36.1
  - @cat-factory/gatekeeper-bindings@0.18.1

## 0.6.9

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/sdk@0.36.0
  - @cat-factory/gatekeeper-bindings@0.18.0

## 0.6.8

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/sdk@0.35.0
  - @cat-factory/gatekeeper-bindings@0.17.0

## 0.6.7

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/sdk@0.34.0
  - @cat-factory/gatekeeper-bindings@0.16.0

## 0.6.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/sdk@0.33.0
  - @cat-factory/gatekeeper-bindings@0.15.0

## 0.6.5

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/sdk@0.32.0
  - @cat-factory/gatekeeper-bindings@0.14.0

## 0.6.4

### Patch Changes

- Updated dependencies [2428b6b]
  - @cat-factory/gatekeeper-bindings@0.13.0
  - @cat-factory/sdk@0.31.0

## 0.6.3

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/sdk@0.30.1
  - @cat-factory/gatekeeper-bindings@0.12.1

## 0.6.2

### Patch Changes

- 6fcd58e: Drive this Worker's object model with a real Cloudflare OS, and fix what that found.

  **A deployment must set the `allow_irrevocable_stub_storage` compatibility flag.** `createAccount()`
  hands the workspace a stub it PERSISTS, and workerd refuses to store a stub whose target Worker has
  not opted in, so without the flag a perfectly bound, perfectly configured Gatekeeper is discovered
  and then fails on the first account anyone connects. `deploy/gatekeeper/wrangler.toml` now carries
  it, and a deployment that copied the template earlier has to add it by hand. It is not something
  `GET /health` can report, because a Worker cannot read its own compatibility flags; every gatekeeper
  in the Cloudflare OS repository carries it for the same reason, and a `/rpc`-only deployment pays
  nothing for it.

  The leg that found it is `test/os-live/`, run nightly against a pinned partner commit
  (`GATEKEEPER_OS_REF`) in a workflow of its own, so a change on their side can never block a merge
  here. Cloudflare OS's own integration toolkit boots the real `workshop-backend` beside this Worker
  under wrangler's test harness, which is the only thing that can exercise the three seams a hermetic
  suite structurally cannot: the entrypoint NAMES the workspace resolves and never asks this package
  about, the stubs handed over (the persisted account, and a Durable Object class only the workspace's
  machinery can instantiate), and the transcribed protocol in `src/os/protocol.ts`, where a shape that
  has fallen behind still compiles here and fails there. Nothing about the Worker is re-composed for
  it: the harness boots `test/wrangler.jsonc`, the same file the other two suites use, which is why
  that file is now JSONC rather than TOML.

  No behaviour change in the package itself. The transcribed protocol was diffed against the published
  source and is accurate; the three places it is narrower than the contract are now named at the top of
  the file, so the next reader making that comparison does not re-derive it.

## 0.6.1

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/sdk@0.30.0
  - @cat-factory/gatekeeper-bindings@0.12.0

## 0.6.0

### Minor Changes

- 131474a: Push approval cards and run events to a Cloudflare OS workspace through the contract's hook
  lifecycle, verify a share instead of refusing it, and check a call's arguments against what the
  operation declares.

  Sessions gain `approvals_subscribe(callback)`, `runs_subscribe(callback)` and `hooks_bound()`. A
  bind hands the workspace a `CatFactoryHookController` (a fifth named export the deployment's entry
  module must carry) and stores nothing until the workspace enables it; each delivery then asks for a
  fresh callback and is authorized as an observation before it is pushed. A hook is an accelerator
  over `approvals_list()` and `runs_watched()`, which stay the truth: the live half of a registration
  is a stub and cannot be stored, so a push that finds none counts a `missed` on the record rather
  than passing over it, and `hooks_bound()` publishes that beside `live`.

  A registration is identified by WHERE its deliveries land rather than by the id one bind minted, so
  re-binding after an eviction (the documented remedy for a hook gone quiet) re-arms the same hook
  and carries its counters over instead of leaving a dead row behind for good. The fan-out runs
  behind the delivery's acknowledgement with a deadline per push, so a workspace that hangs cannot
  spend the platform's retry budget on a write that already committed. Each push reports an outcome
  that is folded onto the record as it stands afterwards, because a push awaits a call into another
  Worker and the durable object's input gate is open across it. And a terminal run event pushes the
  cards it SETTLED alongside the run itself, so a card-subscribed gadget stops showing decisions
  nobody can answer.

  `addObserver` now admits a share when the observer's own account tier reaches everything the bound
  tier reaches and masks no more, and refuses while the bound tier can read a telemetry sink. The
  observer must hold an account this deployment minted, checked before any tier is resolved: an
  unknown id resolves to the auto-provisioned tier, which is the tier nearly every account here
  holds, so a viewer connected to another vendor would otherwise measure up as identical to the
  owner. The `/rpc` door serves no hooks (it has no approval queue to register one with) and says so.

  Three behaviour changes to know about. `GET /health` answers a new `os.limitations` array beside
  `os.blockers`, carrying what a workspace could install and would find missing: a deployment that
  does not export `CatFactoryHookController` stays discoverable and refuses hooks. An argument an
  operation does not declare is now a refusal on both doors rather than a value dropped on the way
  through, which is a break for any caller that was sending one; the refusal names what the operation
  does take. And the `/webhook` 202 reports what it DISPATCHED (`hooks: { pushes, topics }`) rather
  than what it delivered, because the fan-out no longer runs in front of the acknowledgement and a
  count of pushes nobody has made yet is indistinguishable from a push every hook refused; the
  per-hook counts are on `hooks_bound()`, where they always were.

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/sdk@0.29.0
  - @cat-factory/gatekeeper-bindings@0.11.0

## 0.5.0

### Minor Changes

- 875daf7: Serve the Cloudflare OS object model, with the workspace's approval queue in front of every call.

  `@cat-factory/gatekeeper-worker` gains four factories a deployment exports under the names the
  workspace resolves: `GatekeeperVendor` (the entrypoint a `GATEKEEPER_*` service binding targets),
  `CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier`. A resource is the paired
  cat-factory workspace, named by a URLPattern over the deployment origin, because the provisioning
  key this Worker holds is scoped to one. On that path each read is authorized before it is MADE (a
  refused observation means the upstream call never happened, which matters most for the reads that
  serve captured agent text) and each write is submitted and performed only when the workspace
  applies it; the tier policy stays the floor underneath. A session owns the queue it was opened
  with: disposing it releases the queue and refuses every action it left undecided, so a resource
  object holds pending work for live sessions only. `/rpc` and the admin routes are unchanged and
  still bearer-gated.

  `GET /health` gains an `os` section reporting whether a Cloudflare OS deployment could discover and
  install this Worker: `{ ok: true, os: { discoverable, blockers } }`, where a blocker is a missing
  object-model export or a policy naming no `autoProvisionedTier`. It is reported rather than folded
  into the status, because a Gatekeeper serving `/rpc` and nothing else is a supported deployment and
  its monitors must not go red on a version bump.

  `@cat-factory/gatekeeper-bindings` gains `SESSION_METHOD_SIGNATURES` (generated, one TypeScript
  method signature per operation) and `renderSessionTypes`, which composes the `.d.ts` a granted
  session serves.

  Policy files gain `autoProvisionedTier`, and a deployment that wants Cloudflare OS discovery must
  set it. It does not inherit from `defaultTier`: a workspace mints accounts with no identity, so no
  account can match a `grants` entry, and sharing one knob would mean turning discovery on also
  widened the `/rpc` door. Existing policies are unaffected and keep working with discovery off.

### Patch Changes

- Updated dependencies [875daf7]
  - @cat-factory/gatekeeper-bindings@0.10.0

## 0.4.3

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/gatekeeper-bindings@0.9.1
  - @cat-factory/sdk@0.28.1

## 0.4.2

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/sdk@0.28.0
  - @cat-factory/gatekeeper-bindings@0.9.0

## 0.4.1

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/sdk@0.27.0
  - @cat-factory/gatekeeper-bindings@0.8.0

## 0.4.0

### Minor Changes

- 11f9efa: Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
  from a browser session. Both additive.

  `GET /api/v1/usage/spend` groups a board's spend over a window (`24h` / `7d` / `30d` / `90d`) by
  one dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets
  against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways.
  `GET /api/v1/usage` answers the budget question and structurally cannot answer this one, since the
  ledger row it aggregates carries no board shape and its window is the current calendar month. The
  long windows are served from the durable `spend_days` rollup, which froze each run's attribution
  while the money was being spent, so a quarterly figure does not move when a service is re-pointed
  at a new repository. `source` and `rolledUpThrough` say which store answered and how far its sweep
  has covered, because a rollup that has never run and a board that spent nothing produce the same
  empty breakdown. There is no `workspace` dimension and no account-wide scope: a workspace-scoped
  key must never learn a sibling board's spend. `rows` is the heaviest `limit` slices (default 100,
  ceiling 500) with `truncated` beside it, because `run` and `ticket` grow with activity rather than
  with a catalog; `totals` aggregates the whole window either way, so a capped answer still reports
  what the board spent and loses only the identity of the tail.

  `GET /api/v1/debug/runs/:runId/llm-export` serves a run's model activity as one self-describing
  bundle, the external counterpart of the app's own export button, for a caller assembling the same
  picture from the overview plus a walk of the call list. It differs from the app's export in the
  half that matters: the rollups are SQL aggregates over every recorded call and do not move with
  `limit`, so a bundle budgeted down to a handful of rows still states what the run actually cost,
  where the internal export folds its numbers from the rows it holds and stops pricing them once
  they are a slice. `truncated` and `order` say that the call rows are a window and which end was
  kept, and `available` says whether the deployment retains LLM telemetry at all, since an unwired
  sink and a run that made no model calls otherwise produce the same document and this one is
  composed to be handed straight to a model.

  The SDK emitters gained the notion of a REQUIRED query parameter, which nothing on the surface had
  until now: the TypeScript client no longer defaults such a query bag to `{}` (a signature promising
  a call the deployment refuses), Python emits it with no default, Go and Java say so on the field
  rather than documenting it as optional, and Java withholds both the no-query call overload and the
  record's empty `none()` factory for such an operation, offering `Query.of(<required>)` instead.
  The MCP and gatekeeper facades refuse a missing required query parameter locally, naming it, the
  way a missing path parameter already was: the reference MCP server forwards a host's arguments
  without validating them against the tool's own input schema, so nothing else was catching it.

  `@cat-factory/gatekeeper-bindings` (breaking, pre-1.0): a binding's `queryParams` is now
  `{ name, required }` records rather than bare names, so a credential-holding front-end can refuse
  what the deployment would refuse instead of forwarding it to collect a 400. Bindings that read
  captured run telemetry carry `telemetrySink`, and the new `TELEMETRY_BINDINGS` export is that list,
  derived from the table. It is what a policy should withhold captured model prompts, tool arguments
  and command output with: all of it sits inside a `read` key's floor, and the hand-typed deny list
  it replaces had already fallen behind the surface, leaving the run LLM export readable by an
  oversight tier that denied every sibling read of the same sink. Generation now fails on a `/debug`
  operation that is not classified either way.

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/sdk@0.26.0
  - @cat-factory/gatekeeper-bindings@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/sdk@0.25.0
  - @cat-factory/gatekeeper-bindings@0.6.0

## 0.3.0

### Minor Changes

- e1e868d: Answer `GET /health` from the whole configuration, not the two bindings the request path happens
  to read

  The documentation sweep on this package claimed `/health` reported "whether the configuration and
  policy compile". It did not. The route returned `{ ok: true }` after assembling a `Gatekeeper`,
  and assembly reads exactly `CAT_FACTORY_BASE_URL`, `PROVISIONING_KEY` and the `STATE` namespace.
  A deployment that never set `WEBHOOK_SECRET`, `OS_SHARED_TOKEN`, `PUBLIC_URL` or `WEBHOOK_ID`
  answered 200 there while `/rpc` refused every call with a 503 and the receiver verified no
  delivery. That is the one answer a health route must never give: a monitor keyed on it agrees the
  deployment is fine.

  The fix was to make the code true rather than to narrow the sentence. `/health` now runs before
  the assembly, checks every binding in one pass, and is green only when the policy also compiles.
  The check is derived from `GatekeeperEnv` through an exhaustive `Record`, so a binding added to
  the interface fails to compile until it says how it is supplied: a binding this check silently
  passed over is a binding whose absence reads as a healthy Gatekeeper.

  One pass rather than the first name the path tripped on, because the operator this serves is
  wiring a deployment: naming one unset binding per redeploy fixes a half-wired Worker one restart
  at a time. Each name now carries the mechanism it actually takes, which the old refusal left
  ambiguous ("set it in wrangler.toml (a var) or with `wrangler secret put` (a credential)") and
  which both READMEs had got wrong in the same direction, telling operators that the secrets live
  in `wrangler.toml`. `wrangler secret put PROVISIONING_KEY` is the whole difference between an
  admin API key in a secret store and one in a git history, so the vars/secrets split is now stated
  once in code and cited by the docs rather than restated by each.

  Behaviour change to watch for: an existing monitor pointed at `/health` on a deployment that was
  never fully wired flips from green to a 503 naming what is unset. That is the report, not a
  regression.

## 0.2.0

### Minor Changes

- ca2a8e3: First release of the Cloudflare OS Gatekeeper machinery as an installable library: the Cap'n Web
  capability surface compiled from `@cat-factory/gatekeeper-bindings`, per-actor API-key minting, the
  verified outbound-webhook receiver and the approval inbox that answers every park a run stops on.

  A deployment supplies only its policy, through `createGatekeeperWorker({ policy })`, and gets the
  policy vocabulary from the runtime-free `@cat-factory/gatekeeper-worker/policy` entry point.
  `deploy/gatekeeper` is the template that installs it; it was previously a copy of all of the above.

  `@cloudflare/workers-types` is a required peer dependency: every type this package publishes is
  stated in terms of the Worker globals, so a consumer without them cannot compile against it.

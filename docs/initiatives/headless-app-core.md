# Headless app core: a framework-neutral client, reducer and contribution vocabulary

**Status:** proposal, no code landed · **Owner:** frontend · **Started:** 2026-09-19

> This is the durable source of truth for a multi-PR initiative. Read it FIRST before picking up
> the next slice; update the checklist at the end of each PR.

## Goal & rationale

A deployment that wants its own UI over the complete cat-factory stack has one option today: fork
the Nuxt layer. `@cat-factory/app` is a thin client with no business logic, and everything it
drives is reachable over HTTP, so the block is not the backend. The block is that the pieces a
second UI needs sit inside the layer as Vue composables, and the extension seams
([ADR 0049](../../backend/docs/adr/0049-modular-vue-adoption.md)) contribute Vue components.

The goal is that a consumer can ship a UI in the framework it already has (React first, because
every embedding host that matters for a developer tool is React: VS Code and JetBrains webviews,
Backstage plugins, GitHub-app UIs) while the platform keeps ONE backend and ONE contract. The
maintainer owns the neutral core and the vocabulary; a binding other than the Vue layer is owned by
whoever ships it.

The audience is internal: our own alternate frontends and deployments we control. That choice sets
the stability model (a promise on one new package, stated in changesets, not an `/api/v2`-style
freeze) and keeps the maintainer's ongoing cost to a changeset line on a binding-facing change.

### What is already in place

The proposal is smaller than it looks because the hard half exists:

- **The session surface is typed and shared.** `@cat-factory/contracts` holds about 620 route
  contracts across 93 files under `src/routes/`, built with `@toad-contracts` `defineApiContract`. The
  backend mounts them through `@toad-contracts/hono`; the SPA sends through
  `@toad-contracts/frontend-http-client` in 61 of its 62 api modules
  ([`composables/api/client.ts`](../../frontend/app/app/composables/api/client.ts)). Both
  libraries are framework-free (`wretch` is the only peer).
- **The event union is a contract.** `WorkspaceEvent` (15 members) lives in
  `contracts/src/events.ts`.
- **The reducer is pure.**
  [`applyWorkspaceEvent.ts`](../../frontend/app/app/composables/workspaceStream/applyWorkspaceEvent.ts)
  takes a `WorkspaceEventTargets` object of 16 bound callbacks and imports no Vue and no Pinia.
  [`coarseRefresh.ts`](../../frontend/app/app/composables/workspaceStream/coarseRefresh.ts) takes a
  `CoarseRefreshDeps` object of five callbacks. Only
  [`useWorkspaceStream.ts`](../../frontend/app/app/composables/useWorkspaceStream.ts) (the socket
  lifecycle, 203 lines) imports `vue`.
- **Auth is plain HTTP.** The session token is a bearer minted by OAuth and returned in the URL
  fragment ([`stores/auth.ts`](../../frontend/app/app/stores/auth.ts)); the WebSocket mints a
  short ticket at `POST /workspaces/:ws/events/ticket` and connects with `?ticket=`. The ticket
  mint is the one write allowlisted past the viewer floor
  ([`authGate.ts`](../../backend/packages/server/src/http/authGate.ts)), so a read-only surface
  can already stream.
- **The neutral engine is a dependency already.** `@modular-frontend/core` ships `defineModule`,
  slots, `RemoteModuleManifest`, `resolveComponentRegistry` / `pairById`, `definePanelGroup` /
  `resolvePanels` and `defineOverlayHost` / `resolveOverlay` as framework-free primitives; React,
  Vue and Angular bindings sit on top. Cat-factory consumes the Vue binding.

So the work is: settle who owns the app-local types the api modules import, retire the last raw
`$fetch` routes, lift the auth flow out of the store, package what exists, state a stability
promise on the new package, own the i18n key map as data, and split the Vue-coupled slot entries
into a framework-neutral spec plus a per-framework pairing.

## Why not the two surfaces that already exist

- **`/api/v1` plus the four SDKs.** A curated, frozen automation subset
  ([ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)). It lists and runs pipelines
  but cannot author them, cannot edit board structure, and streams coarse SSE. Growing it to UI
  parity would freeze board and pipeline authoring into an additive-only, four-language contract
  for an audience (external automation) that does not need it. Rejected; `/api/v1` stays what it
  is.
- **Extending the Nuxt layer through `registerAppModule`.** The right tool for a Vue consumer
  adding a panel or a window
  ([frontend-extension-mechanism](./frontend-extension-mechanism.md)). It cannot hand a React
  host anything: the contributions are Vue components. Rejected as the vehicle; its id and slot
  vocabulary is what this initiative lifts out.

## Vocabulary

- **App core**: `@cat-factory/app-core`, the new framework-free package: the contract sender, the
  auth flow, the version handshake, the stream (ticket, socket, reconcile), the reducer, and the
  framework-neutral half of every contribution slot.
- **Binding**: a package that renders app core's state with one framework and pairs its id
  vocabulary with components. `@cat-factory/app` (Vue/Nuxt) is the first binding.
- **Targets seam**: `WorkspaceEventTargets`, the callback interface a binding implements to
  receive routed events. The frozen contract for live updates.
- **Contribution spec**: the framework-neutral half of a slot entry (id, order, labels, action
  ids, and its predicates and resolvers as plain functions). It ships as code in app core and never
  crosses a wire. **Pairing**: the framework half, an id mapped to a component inside a binding.

## Target pattern

```
@cat-factory/contracts            route contracts, WorkspaceEvent, agent-kind presentation
        |
        v
@cat-factory/app-core             send(contract) · token · ticket + socket · applyWorkspaceEvent
                                  coarseRefresh · WorkspaceEventTargets · contribution specs
        |                                   |
        v                                   v
@cat-factory/app (Vue/Nuxt)        <consumer>/app-react (out of tree)
  Pinia stores implement targets     Zustand/Redux store implements targets
  ComponentEntry pairs ids -> SFCs   ComponentEntry pairs ids -> React components
```

The cross-framework contract is the contracts package, the targets seam, and the id vocabulary.
Components are never the contract.

## Decisions

### D1. The promise sits on `app-core` only; `contracts` keeps its pre-1.0 freedom

This adds a THIRD stability tier, and it is stated as one. Today there are two: `/api/v1`, the
SDKs and webhook delivery are stable ([ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)),
and everything internal is pre-1.0 and breaks freely (`CLAUDE.md`). `@cat-factory/contracts` is in
the second tier: it is at 0.355.1 and is reshaped in ordinary PRs. This proposal does not move it.
The new tier is `@cat-factory/app-core`: promised to bindings, internal audience, no deprecation
windows, no dual shapes.

What is promised, exactly: that a change to app core's exported surface is ANNOUNCED. What is not
promised: that a binding built against one app core runs against a backend built against another.
App core re-exports the contract types and validates every response against them, so the
deployment contract is LOCKSTEP: a binding and the backend it talks to ship from the same contracts
version, the way the Vue layer and the backend already do inside one deployment. Cross-version
pairs are unsupported, and the alternative (app core owning stable DTOs and adapting the unstable
contracts behind them) is a second copy of about 620 shapes, the exact thing "Deliberately NOT
pursued" rejects for a generated client.

Unsupported must fail as a statement, not as a decode error somewhere in a store. Today nothing
carries a version: neither `/health` nor the workspace snapshot reports one, so a mismatch surfaces
as an `UnexpectedResponseError` with no cause named. The handshake: the backend reports the
`@cat-factory/contracts` version it was built with on the bootstrap snapshot (the first thing app
core reads), app core carries the version it was built against, and a mismatch puts the client
into a typed `incompatible` state with both versions, before any store is touched. A binding
renders that state; it never sees a half-hydrated board.

What that means in daily work:

- A PR that reshapes a route contract or an event member changes none of its habits, as long as
  the backend and the Vue binding still agree. Where the reshape changes an `app-core` export (an
  api module's signature, a re-exported type a binding reads, a targets callback), the PR adds one
  changeset line under `@cat-factory/app-core` naming what a binding must change. That line is the
  gate; a version number is not. A "major" on a 0.x package carries no signal, so app core
  publishes `1.0.0` when the last slice lands, and until then every binding-facing break is the
  changeset entry itself.
- A binding pins an `app-core` range and reads the changelog on bump. Nothing else is promised.

Rejected alternative: promising stability on `contracts` itself. It would put a consumer contract
on the package the backend reshapes most, and reverse the internals rule with no migration story
behind it.

### D2. `@cat-factory/app-core` holds exactly what every binding needs and nothing a binding owns

Contents: `createApiClient` / `createSend` (the `wretch` + `@toad-contracts/frontend-http-client`
composition from `composables/api/client.ts`), the 62 per-resource api modules, the auth flow as
a framework-neutral state machine (everything `stores/auth.ts`, `stores/auth/session.ts` and
`stores/auth/mothership.ts` do today: login by provider, redirect-fragment token consumption, SSO
refusal handling, the mothership session exchange, invite redemption, local PAT login, the 401
re-gate, and the bootstrap ordering between them, with the store as a target rather than the
owner), the ticket mint plus socket lifecycle with reconnect and reconcile (today's
`useWorkspaceStream.ts` minus `ref` and `onScopeDispose`), `applyWorkspaceEvent`,
`createCoarseRefresh`, `WorkspaceEventTargets`, the version handshake from D1, and the
contribution specs from D4. The auth flow is in scope because it is the most failure-prone client
logic there is; a "token holder" alone would make every binding rewrite it.

Not in it: stores, components, i18n rendering, routing, anything that names a framework. Two guards
enforce that, because an import check alone cannot see the seam growing Vue-shaped assumptions:

- A dependency guard fails the package on an import of `vue`, `nuxt`, `pinia`, `#app` or
  `#imports`.
- A framework-free vitest suite drives the client, the stream lifecycle and the reducer against a
  plain-object store, in CI's "Test units (no DB)" lane. It is the only proof of the seam that
  lives in this repository, since D5 and D7 place bindings and the React proof out of tree; a
  change that only a Vue store can satisfy fails here.

`@modular-frontend/core` is a PEER dependency of app core, never a direct one, and app core
re-exports the resolvers a binding needs. The reason is the trap `pnpm-workspace.yaml` already
documents with its exact `0.6.0` override: two copies of the engine give `PanelEntry`,
`OverlayEntry` and journey step metadata distinct type identities, the same way an exact-version
`workspace:*` publish gives a floating consumer two copies. An out-of-tree binding has no override,
so the only safe shape is one engine copy the binding installs and app core resolves against.

Location: `frontend/app-core`, a new workspace member beside `frontend/app`. It has no Nuxt
dependency, so it cannot live inside the layer, and it is UI-side code, so it does not belong
under `backend/packages/` beside contracts.

### D3. Live updates freeze the targets seam, not the payloads

Three options were weighed:

| Option                                              | Cost                                                                                                              | Verdict    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| Freeze the full `WorkspaceEvent` union              | Every member carries whole entities (`Block`, `ExecutionInstance`, the session types), so their shapes freeze too | Too heavy  |
| Coarse public SSE only                              | Cannot drive a live board                                                                                         | Too little |
| Freeze `WorkspaceEventTargets` and ship the reducer | A binding implements 16 upserts on its own store and never switches on `type`                                     | Chosen     |

A new event member arrives as a new OPTIONAL callback, so the seam is additive by construction.
Optional cannot mean ignorable: a socket that stays open never runs the reconnect reconcile, so a
binding that lacks a target would keep stale state for the rest of the session. The correctness
rule is therefore: `refreshBoard` (the debounced coarse reconcile, already a target today) is the
ONE REQUIRED callback, and an event with no target, whether unknown to this app core or not
implemented by this binding, routes to it and logs one stated warning. The binding then re-reads
the snapshot and is current again, at the cost of one refresh.

That fallback is sound because the workspace snapshot hydrates the state behind every current
member except `llmCall`, which is append-only activity: a missed one is a gap in a feed, not a
stale entity. A future member whose state lives outside the snapshot ships with a typed
invalidation target of its own, never as optional-only; the version handshake in D1 covers the
case where a binding is too old to know the member exists at all.

Entity shapes still come from contracts, which keeps its pre-1.0 freedom (D1); a reshape reaches a
binding as an app-core changeset line.

This is also where slice F of the extension initiative lands: the `custom` member and the
per-kind handler registration attach to the reducer in app core, so every binding gets consumer
stream events for free and the Vue `onMessage` switch never grows a branch. ADR 0049 named the
fan-out a choke point to leave alone "until a dedicated event-fan-out initiative"; this is that
initiative.

### D4. Every slot entry splits into a framework-neutral spec and a per-binding pairing

`AppSlots` ([`modular/slots.ts`](../../frontend/app/app/modular/slots.ts)) today mixes
framework-neutral logic and `Component` references in one object per entry. The specs are NOT
JSON: inspector panels carry `when(block)`, nav and external tools carry `gate` predicates,
external tools carry a URL resolver (`ExternalToolUrlResolver` in `modular/external-tools.ts`),
tutorial steps carry `when(gates)`. They are executable, and this proposal keeps them so: a spec is
code that ships in app core, imports only contracts and the engine, and is called by any binding.
Nothing here crosses a wire, so no condition vocabulary is invented. The ONE spec that does cross a
wire is `agentKinds`, which the backend already declares as a per-workspace `RemoteModuleManifest`
under upstream's own JSON-safe subset, and it stays there.

| Slot                                   | Spec (app core, code)                                                                 | Pairing (binding)                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `nav`                                  | id, label key, group, `NavActionId`, `gate(gates)`                                    | icon component, action handler map         |
| `resultViews`, `taskTypeFormPanels`    | id                                                                                    | `ComponentEntry` id → component            |
| `inspectorPanels`                      | id, order, `when(block)` (already separate in `panels/inspector.logic.ts`)            | `PanelEntry` id → component                |
| `appOverlays`                          | id, title key                                                                         | `OverlayEntry` id → component              |
| `externalTools`                        | id, label key, `gate(gates)`, URL resolver                                            | none                                       |
| `taskTypes`, `workspaceMetadataFields` | already framework-neutral                                                             | none                                       |
| `agentKinds`                           | stays in contracts: the backend declares it as a per-workspace `RemoteModuleManifest` | `ComponentEntry` for the result view       |
| `tutorialTours`                        | step ids, anchors, `when(gates)`                                                      | none needed; a binding may ignore the slot |

The spec resolvers (`resolvePanels`, `resolveComponentRegistry`, `resolveOverlay`) are already
`@modular-frontend/core` exports; app core re-exports them from its peer (D2) rather than
re-implementing them, and a binding never imports the engine directly. A consumer registers a spec
once and a pairing per binding it ships.

### D5. Bindings are owned by whoever ships them, and carry no parity claim

The maintainer owns `contracts`, `app-core` and the vocabulary. `@cat-factory/app` stays the
reference binding and the first consumer of app core. Any other binding lives OUT of this
repository, pins an `app-core` range, and is that owner's to keep current. This repo's runtime
symmetry rule does not extend to bindings: a React binding one version behind is not a
showstopper here, and no CI in this repo tests it.

The reason is cost. An in-tree second binding would inherit the parity rule by analogy and double
frontend work per feature. The proposal asks the maintainer to own the seam, not a second UI.

### D6. Auth is reused as is; no UI-scoped credential tier

A binding completes the existing OAuth round trip, stores the bearer, replays it as
`Authorization: Bearer`, and mints stream tickets. Where the browser lands after login is decided
by `pickPostLoginRedirect` in
[`loginFlow.ts`](../../backend/packages/server/src/modules/auth/loginFlow.ts): the requested
`redirect` is honoured when it is same-origin, listed in `AUTH_ALLOWED_REDIRECT_ORIGINS`, or a
loopback host (`localhost`, `127.0.0.0/8`, `::1`); otherwise the request origin wins. So a second
UI origin works when the operator lists it, and a local development server on the developer's own
machine works with no configuration.

That does NOT cover an IDE webview directly. A VS Code or JetBrains webview is not an `http(s)`
origin, and `pickPostLoginRedirect` refuses any other protocol before it looks at the host, so the
backend can never redirect into one. The design for that case needs no backend change: the
extension host opens a short-lived loopback listener and names it as the `redirect`, which IS a
loopback `http` origin and so is honoured; the listener receives the fragment, and the host hands
the token to the webview over the IDE's own message channel, never through a URL. The security
boundary is the same one the loopback rule already accepts: the token lands in a process on the
developer's machine that the developer runs. The React proof (D7) is a browser app and does not
exercise this path; an IDE binding is its own slice with this design as its starting point.

Two traps a binding author has to know:

- `AUTH_SUCCESS_REDIRECT_URL`, when set, overrides every requested redirect and pins each login to
  one UI. A deployment with two UIs leaves it unset.
- `CORS_ALLOWED_ORIGINS` is a separate gate: a second browser origin has to be on it as well, or
  the redirect succeeds and every API call then fails preflight.

### D7. A read-only React board is the acceptance test for the seam

The extraction slice is a move and proves nothing about the seam on its own beyond the headless
suite in D2. The proof is a small React app, out of tree, that signs in, hydrates a board through
app core, subscribes to the stream, and implements the targets on a Zustand store. It is done when
a run started in the Vue SPA advances live in the React view with no code in the React app that
names an event `type`. What it surfaces goes into the gotchas section here; what it needs from app
core lands as slices.

### D8. App core owns the reason-to-key map and the `en` reference catalog; catalogs stay per binding

The backend does not localize prose. A failure carries a machine-readable `error.details.reason`
and the SPA maps it to a frontend key through `usePipelineErrorToast` (with `UNAVAILABLE_REASONS`
as an exhaustive `Record`). The catalog behind those keys is about 6400 keys in `en.json`, in 10
locales. A binding that starts without this starts with no copy at all and re-derives the
reason-to-key mapping by hand, which is the drift the i18n rule exists to prevent.

The split: the reason-to-key map is framework-free data and moves to app core, beside the
contracts vocabulary it maps from, with the exhaustiveness check that fails the build when a
reason gains no key. App core also ships the `en` catalog as the reference the keys are written
against. Rendering, the i18n library, locale loading and the nine other catalogs stay in each
binding; the Vue layer keeps its deep-merge and its locale-parity guard unchanged. A binding may
copy or translate `en` as it sees fit; the platform promises the keys, not the prose.

## Why now: what this unlocks

Ranked by how much each depends on this split rather than on modularity in general.

1. **Cat-factory inside the tools developers already use.** A Backstage plugin or a VS Code panel
   becomes a thin React binding over the same live stream and contracts, instead of polling
   `/api/v1`.
2. **One surface per audience instead of one SPA with hidden fields.** The `basic`/`advanced` tier
   and the `intake` role are implemented as hiding today. A form-first intake app or a read-only
   wallboard (the viewer-tier ticket exists for exactly this and nothing uses it outside the SPA)
   becomes a small binding over a subset of the store.
3. **Store coherence becomes a unit test.** The repo's flake rule says a flaky e2e is almost always
   a store reconcile or a readiness gate. With connect, reconcile, debounce and routing in app core,
   those races run headless under vitest against a real backend instead of only through Playwright.
4. **A headless operator with the human's capability.** `sdk/mcp` exposes `/api/v1` only, so an
   agent can run pipelines but not author them. A session-authed headless client gives an internal
   assistant, a CLI or the mothership local node the full board with the live stream. The
   `assistant` api module and mothership mode would each otherwise build their own.
5. **Consumers on a React design system can adopt at all.** `deploy/frontend` extends the Nuxt
   layer, so an organisation with a React component library rebrands and stops.
6. **Slices E and F of the extension initiative close.** F is D3; E's `notificationKinds` spec is a
   D4 row.

## What stays unchanged

- The backend, every route, every controller, the event publisher. Nothing new is reachable; what
  changes is who can reach it and from where.
- `/api/v1`, the four SDKs, `sdk/mcp` and their stability rule.
- `@cat-factory/contracts` and its pre-1.0 freedom (D1).
- The Vue SPA's behaviour: the extraction is a move, and every later slice keeps the Vue binding
  byte-for-byte equivalent for the user.
- `registerAppModule` for Vue consumers: it keeps working, now registering a spec plus a Vue
  pairing.

## Per-slice status

| #   | Slice                                 | Deliverable                                                                                                                                                                                                                                                                                                                                                  | Status | PR  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 0   | Tracker                               | This document                                                                                                                                                                                                                                                                                                                                                | done   | —   |
| 1   | Type ownership                        | 37 api modules import 28 `~/types/*` modules today (`domain`, `execution`, `merge`, `tracker`, `notifications`, ...). Each type is placed: a wire shape moves to contracts, a client shape moves with the api modules, a frontend-only type (`AgentArchetype`, `TaskTypeMeta`, `LodLevel`, palette, level of detail) stays in the layer; no behaviour change | todo   | —   |
| 2   | Retire the raw `$fetch` routes        | The three api modules still on Nuxt's `$fetch` (`auth.ts` ticket mint, `provisioningLogs.ts`, `visualConfirm.ts` blob upload) move to contract routes, or to a plain `fetch` where a body is binary; `ApiHttp` leaves `api/context.ts`                                                                                                                       | todo   | —   |
| 3   | Auth flow as a state machine          | `stores/auth.ts`, `stores/auth/session.ts` and `stores/auth/mothership.ts` reduced to a Pinia target over a framework-neutral flow (login by provider, redirect-fragment consumption, SSO refusal, mothership exchange, invite redemption, PAT login, 401 re-gate, bootstrap order); headless tests                                                          | todo   | —   |
| 4   | Extract `@cat-factory/app-core`       | `frontend/app-core` with client, api modules, auth flow, stream lifecycle, reducer, coarse refresh; SPA consumes it; dependency guard; headless suite in the no-DB lane; engine as peer; the [new published package checklist](../internal/releases.md#adding-a-new-published-package)                                                                       | todo   | —   |
| 5   | Version handshake                     | Backend reports its contracts version on the bootstrap snapshot; app core compares against the version it was built with and enters a typed `incompatible` state on mismatch; conformance assertion on both runtimes                                                                                                                                         | todo   | —   |
| 6   | Targets seam as the promised contract | `WorkspaceEventTargets` documented as the stability surface with `refreshBoard` required; unhandled event routes to it with one warning; slice F (`custom` member + handler registration) on the reducer                                                                                                                                                     | todo   | —   |
| 7   | Slot spec / pairing split             | Each `AppSlots` row from D4 split; `registerAppModule` accepts spec + Vue pairing; consumer example updated                                                                                                                                                                                                                                                  | todo   | —   |
| 8   | i18n key map and `en` reference       | Reason-to-key map as data in app core with its exhaustiveness check; `en` catalog shipped from app core; Vue layer loads it unchanged                                                                                                                                                                                                                        | todo   | —   |
| 9   | Read-only React proof (out of tree)   | Sign-in, board hydrate, live stream on a Zustand store; findings recorded here; app-core gaps filed as slices                                                                                                                                                                                                                                                | todo   | —   |
| 10  | Promise written down; `1.0.0`; ADR    | Changeset rule and the lockstep contract in the `app-core` README; `frontend/app/README.md` points at app core; app core publishes `1.0.0`; tracker converts to an ADR                                                                                                                                                                                       | todo   | —   |

Slices 1 to 3 are prerequisites the extraction cannot skip: without them the move drags Nuxt's
`$fetch`, a Pinia-shaped auth flow and two dozen layer-local type modules into the package, and
the dependency guard fails on day one.

## Conventions & gotchas (carry between iterations)

- **The reducer stays callback-shaped.** A branch that reaches for a store, even through an
  import, breaks the seam for every binding. Every dependency is a bound callback, the way
  `applyWorkspaceEvent` and `coarseRefresh` already do it.
- **A component reference in app core is a bug**, whatever the framework. If a spec needs to
  select a component, it carries a string id and the binding pairs it.
- **Additive means optional, and optional means "falls back to `refreshBoard`".** A new targets
  callback is optional; an event with no target reconciles coarsely and warns once. A member whose
  state is outside the snapshot ships with its own invalidation target (D3). Making an existing
  callback required is a binding-facing break and gets the changeset line (D1).
- **Lockstep is the deployment contract.** A binding ships from the same contracts version as the
  backend it talks to; the handshake makes a violation a stated `incompatible`, never a decode
  error (D1).
- **A spec is code, not JSON.** Predicates and resolvers stay functions in app core; only
  `agentKinds` crosses a wire, and it does so under upstream's JSON-safe manifest subset (D4).
- **One engine copy.** App core never lists `@modular-frontend/core` as a direct dependency and
  never re-implements a resolver it exports; a binding never imports the engine itself (D2).
- **Keep the co-evolution loop.** A primitive app core needs that `@modular-frontend/core` lacks
  is filed upstream and re-adopted, per ADR 0049; no local shim outlives its slice.
- **The `agentKinds` presentation stays backend-declared.** It arrives as a
  `RemoteModuleManifest` per workspace; app core does not restate it.

## Deliberately NOT pursued

- **A framework-agnostic component runtime** (web components, micro-frontends, rendering Vue
  inside React). Upstream's own guidance rejects a manifest that "conjures a component the build
  didn't ship". Components ship as code, per binding.
- **Freezing the full `WorkspaceEvent` union.** Every entity change would be a break (D3).
- **Growing `/api/v1` to UI parity.** Wrong audience, wrong cost (see "Why not").
- **An in-tree second binding.** Doubles frontend work for the maintainer (D5).
- **A UI-scoped key tier.** The bearer plus ticket flow already serves any client (D6).
- **A generated client for the session surface.** The contracts ARE the client's input; the
  `@toad-contracts` sender is already type-derived. A generator would be a second copy.

## Open questions for the maintainer

1. `frontend/app-core` as the location (D2), or a different home for a UI-side package with no
   Nuxt dependency?
2. D1 states a third stability tier, keeps `contracts` free, and makes lockstep the deployment
   contract with a version handshake on the bootstrap snapshot. Is the snapshot the right carrier,
   or should the version ride an unauthenticated meta route so a binding can check before login?
3. Slice F: agree to land it as the reducer-side registration in app core rather than a branch in
   the Vue `onMessage` switch (D3)?
4. Contribution vocabulary ownership: agent-kind presentation in contracts, everything else in
   app core (D4). Any row that should move?
5. D8 ships the `en` catalog from app core. Is that wanted, or only the key list, with every
   catalog including `en` staying in the Vue layer?

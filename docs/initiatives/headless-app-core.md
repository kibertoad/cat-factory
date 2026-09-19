# Framework-neutral app core: shared client, reducer and contribution vocabulary

**Status:** proposal, no code landed · **Owner:** frontend · **Started:** 2026-09-19

> This is the durable source of truth for a multi-PR initiative. Read it FIRST before picking up
> the next slice; update the checklist at the end of each PR.

## Goal & rationale

A deployment that wants its own UI over the complete cat-factory stack has one option today: fork
the Nuxt layer. Everything the app drives is reachable over HTTP, so the block is not the backend.
The block is that the client orchestration a second UI needs sits inside Vue composables and Pinia
stores, and the extension seams
([ADR 0049](../../backend/docs/adr/0049-modular-vue-adoption.md)) contribute Vue components.

The goal is that a consumer can ship a browser UI in the framework it already uses while the
platform keeps ONE backend and ONE contract. React is the first proof because it exercises the seam
from outside the existing Vue layer; it is not a product constraint or a commitment to a particular
host. The maintainer owns the neutral core and the vocabulary; a binding other than the Vue layer
is owned by whoever ships it.

The audience is internal: our own alternate frontends and deployments we control. App core stays
under the repository's existing pre-1.0 compatibility rule and records binding-facing changes in
changesets.

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
`$fetch` routes, lift the auth flow out of the store, package what exists, and split the
Vue-coupled slot entries into a framework-neutral spec plus a per-framework pairing.

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
  auth flow, the stream (ticket, socket, reconcile), the reducer, and the
  framework-neutral half of every contribution slot.
- **Binding**: a package that renders app core's state with one framework and pairs its id
  vocabulary with components. `@cat-factory/app` (Vue/Nuxt) is the first binding.
- **Targets seam**: `WorkspaceEventTargets`, the callback interface a binding implements to
  receive routed events without switching on the wire event union.
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

### D1. App core keeps the existing internal lockstep contract

This proposal does not add a third stability tier. `/api/v1`, the SDKs and webhook delivery keep
their stable public contract
([ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)); `@cat-factory/contracts` and the
new `@cat-factory/app-core` remain internal, pre-1.0 packages under `CLAUDE.md`'s existing rule.

App core re-exports contract types and validates responses against them. A binding and the backend
it talks to therefore ship from compatible repository revisions, as the Vue layer and backend do
today. Cross-version compatibility is not promised. A consumer that owns a separate binding also
owns coordinating its frontend and backend upgrade.

Every binding-facing change still gets an `@cat-factory/app-core` changeset that names what the
binding must update. That is release communication, not a compatibility protocol. This initiative
does not add a backend version endpoint, duplicate the route shapes behind stable DTOs, or publish
app core as `1.0.0`. If independently deployed bindings later become a product requirement, their
compatibility window and failure handshake need their own design before a stable release.

### D2. `@cat-factory/app-core` holds exactly what every binding needs and nothing a binding owns

Contents: `createApiClient` / `createSend` (the `wretch` + `@toad-contracts/frontend-http-client`
composition from `composables/api/client.ts`), the 62 per-resource api modules, the auth flow as
a framework-neutral state machine (everything `stores/auth.ts`, `stores/auth/session.ts` and
`stores/auth/mothership.ts` do today: login by provider, redirect-fragment token consumption, SSO
refusal handling, the mothership session exchange, invite redemption, local PAT login, the 401
re-gate, and the bootstrap ordering between them, with the store as a target rather than the
owner), the ticket mint plus socket lifecycle with reconnect and reconcile (today's
`useWorkspaceStream.ts` minus `ref` and `onScopeDispose`), `applyWorkspaceEvent`,
`createCoarseRefresh`, `WorkspaceEventTargets`, and the
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

### D3. Live updates route through required targets, not binding-owned event switches

Three options were weighed:

| Option                                       | Cost                                                                                                              | Verdict    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| Freeze the full `WorkspaceEvent` union       | Every member carries whole entities (`Block`, `ExecutionInstance`, the session types), so their shapes freeze too | Too heavy  |
| Coarse public SSE only                       | Cannot drive a live board                                                                                         | Too little |
| Ship `WorkspaceEventTargets` and the reducer | A binding implements 16 upserts on its own store and never switches on `type`                                     | Chosen     |

Every target callback stays required. A new event member lands with its reducer branch and target
callback, so a binding upgrading app core fails to compile until it decides how to store that
event. This is a binding-facing change and its changeset names the new callback. The internal,
lockstep audience makes that honest break cheaper than an optional callback that silently loses
state.

There is no correct generic refresh fallback. The workspace snapshot covers the board and several
eager stores, but requirements, clarity, brainstorm, consensus sessions, Kaizen activity and
document interviews are lazy caches outside it. A board refresh would clear or miss those rather
than apply the event. An event unknown at runtime therefore logs one warning and is dropped, as it
is today; that case means the unsupported cross-version pairing from D1 is already running.

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
symmetry rule does not extend to bindings: a change here does not block on parity in an external
binding, and that binding's owner updates it before deploying it against a changed backend. No CI
in this repo tests an external binding.

The reason is cost. An in-tree second binding would inherit the parity rule by analogy and double
frontend work per feature. The proposal asks the maintainer to own the seam, not a second UI.

### D6. Auth is reused as is; no UI-scoped credential tier

A binding completes the existing OAuth round trip, stores the bearer, replays it as
`Authorization: Bearer`, and mints stream tickets. Where the browser lands after login is decided
by `pickPostLoginRedirect` in
[`loginFlow.ts`](../../backend/packages/server/src/modules/auth/loginFlow.ts): the requested
`redirect` is honoured when it is same-origin, listed in `AUTH_ALLOWED_REDIRECT_ORIGINS`, or a
loopback host (`localhost`, `127.0.0.0/8`, `::1`); otherwise the request origin wins. So a second
UI origin works when the operator lists it. A local development server needs no redirect
allow-list entry; the separate CORS policy below still applies.

Two traps a binding author has to know:

- `AUTH_SUCCESS_REDIRECT_URL`, when set, overrides every requested redirect and pins each login to
  one UI. A deployment with two UIs leaves it unset.
- `CORS_ALLOWED_ORIGINS` is a separate gate: a second browser origin has to be on it as well, or
  the redirect succeeds and every API call then fails preflight.

### D7. A read-only React board is the acceptance test for the seam

The extraction slice is a move and proves nothing about the seam on its own beyond the framework-free
suite in D2. The proof is a small React app, out of tree, that signs in, hydrates a board through
app core, subscribes to the stream, and implements the targets on a Zustand store. It is done when
a run started in the Vue SPA advances live in the React view with no code in the React app that
names an event `type`. What it surfaces goes into the gotchas section here; what it needs from app
core lands as slices.

## Why now: what this unlocks

Ranked by how much each depends on this split rather than on modularity in general.

1. **One surface per audience instead of one SPA with hidden fields.** The `basic`/`advanced` tier
   and the `intake` role are implemented as hiding today. A form-first intake app or a read-only
   wallboard (the viewer-tier ticket exists for exactly this and nothing uses it outside the SPA)
   becomes a small binding over a subset of the store.
2. **Store coherence becomes a unit test.** The repo's flake rule says a flaky e2e is almost always
   a store reconcile or a readiness gate. With connect, reconcile, debounce and routing in app core,
   those races run framework-free under vitest against a controlled transport instead of only
   through Playwright.
3. **Consumers on another design system can adopt at all.** `deploy/frontend` extends the Nuxt
   layer, so an organisation with a React component library rebrands and stops.
4. **Slices E and F of the extension initiative close.** F is D3; E's `notificationKinds` spec is a
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

| #   | Slice                               | Deliverable                                                                                                                                                                                                                                                                                                                                                  | Status | PR  |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 0   | Tracker                             | This document                                                                                                                                                                                                                                                                                                                                                | done   | —   |
| 1   | Type ownership                      | 31 api modules import 25 `~/types/*` modules today (`domain`, `execution`, `merge`, `tracker`, `notifications`, ...). Each type is placed: a wire shape moves to contracts, a client shape moves with the api modules, a frontend-only type (`AgentArchetype`, `TaskTypeMeta`, `LodLevel`, palette, level of detail) stays in the layer; no behaviour change | todo   | —   |
| 2   | Retire the raw `$fetch` routes      | The three api modules still on Nuxt's `$fetch` (`auth.ts` ticket mint, `provisioningLogs.ts`, `visualConfirm.ts` blob upload) move to contract routes, or to a plain `fetch` where a body is binary; `ApiHttp` leaves `api/context.ts`                                                                                                                       | todo   | —   |
| 3   | Auth flow as a state machine        | `stores/auth.ts`, `stores/auth/session.ts` and `stores/auth/mothership.ts` reduced to a Pinia target over a framework-neutral flow (login by provider, redirect-fragment consumption, SSO refusal, mothership exchange, invite redemption, PAT login, 401 re-gate, bootstrap order); framework-free tests                                                    | todo   | —   |
| 4   | Extract `@cat-factory/app-core`     | `frontend/app-core` with client, api modules, auth flow, stream lifecycle, reducer, coarse refresh; SPA consumes it; dependency guard; framework-free suite in the no-DB lane; engine as peer; the [new published package checklist](../internal/releases.md#adding-a-new-published-package)                                                                 | todo   | —   |
| 5   | Targets seam                        | `WorkspaceEventTargets` documented as the required routing surface; unknown runtime event warning; slice F (`custom` member + handler registration) on the reducer                                                                                                                                                                                           | todo   | —   |
| 6   | Slot spec / pairing split           | Each `AppSlots` row from D4 split; `registerAppModule` accepts spec + Vue pairing; consumer example updated                                                                                                                                                                                                                                                  | todo   | —   |
| 7   | Read-only React proof (out of tree) | Sign-in, board hydrate, live stream on a Zustand store; findings recorded here; app-core gaps filed as slices                                                                                                                                                                                                                                                | todo   | —   |
| 8   | Package contract and ADR            | Changeset and lockstep rules in the `app-core` README; `frontend/app/README.md` points at app core; tracker converts to an ADR                                                                                                                                                                                                                               | todo   | —   |

Slices 1 to 3 are prerequisites the extraction cannot skip: without them the move drags Nuxt's
`$fetch`, a Pinia-shaped auth flow and two dozen layer-local type modules into the package, and
the dependency guard fails on day one.

## Conventions & gotchas (carry between iterations)

- **The reducer stays callback-shaped.** A branch that reaches for a store, even through an
  import, breaks the seam for every binding. Every dependency is a bound callback, the way
  `applyWorkspaceEvent` and `coarseRefresh` already do it.
- **A component reference in app core is a bug**, whatever the framework. If a spec needs to
  select a component, it carries a string id and the binding pairs it.
- **Every event target is required.** A new event member changes the target interface and gets a
  binding-facing changeset. There is no generic refresh fallback for state outside the workspace
  snapshot (D3).
- **Lockstep is the deployment contract.** A binding and its backend ship from compatible
  repository revisions. Supporting independent upgrades is outside this initiative (D1).
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
- **Non-browser hosts and non-frontend consumers.** This initiative supports browser frontends on
  ordinary `http(s)` origins. Other hosts and consumers need their own requirements and acceptance
  criteria.
- **A shared localization catalog.** App core carries machine-readable error vocabulary; each
  binding owns its copy, actions, i18n library and catalogs.
- **A UI-scoped key tier.** The bearer plus ticket flow already serves any client (D6).
- **A generated client for the session surface.** The contracts ARE the client's input; the
  `@toad-contracts` sender is already type-derived. A generator would be a second copy.

## Open questions for the maintainer

1. `frontend/app-core` as the location (D2), or a different home for a UI-side package with no
   Nuxt dependency?
2. Slice F: agree to land it as the reducer-side registration in app core rather than a branch in
   the Vue `onMessage` switch (D3)?
3. Contribution vocabulary ownership: agent-kind presentation in contracts, everything else in
   app core (D4). Any row that should move?

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
the stability model (semver on a package, not an `/api/v2`-style freeze) and keeps the maintainer's
ongoing cost to a changeset line on a breaking change.

### What is already in place

The proposal is smaller than it looks because the hard half exists:

- **The session surface is typed and shared.** `@cat-factory/contracts` holds 621 route contracts
  across 93 files under `src/routes/`, built with `@toad-contracts` `defineApiContract`. The
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

So the work is: package what exists, state a stability promise, and split the Vue-coupled slot
entries into data plus per-framework pairing.

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
  token holder, the stream (ticket, socket, reconcile), the reducer, and the data half of every
  contribution slot.
- **Binding**: a package that renders app core's state with one framework and pairs its id
  vocabulary with components. `@cat-factory/app` (Vue/Nuxt) is the first binding.
- **Targets seam**: `WorkspaceEventTargets`, the callback interface a binding implements to
  receive routed events. The frozen contract for live updates.
- **Contribution spec**: the JSON-safe half of a slot entry (id, order, `when`, labels, action
  ids). **Pairing**: the framework half, an id mapped to a component inside a binding.

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

### D1. The session surface is the UI contract; stability is semver on two packages

`@cat-factory/contracts` and `@cat-factory/app-core` are the contract. A change to a route
contract, an event member or a targets callback that a pinned consumer cannot absorb is a MAJOR
bump with a changeset note naming what moved. Additive changes (a new route, a new optional
callback, a new slot spec field) are minors and ship freely. `/api/v1` keeps its own, stricter
rule. No deprecation windows, no dual shapes: the internal audience pins a range and updates.

### D2. `@cat-factory/app-core` holds exactly what every binding needs and nothing a binding owns

Contents: `createApiClient` / `createSend` (the `wretch` + `@toad-contracts/frontend-http-client`
composition from `composables/api/client.ts`), the 62 per-resource api modules, a token holder
with the 401 re-gate hook, the ticket mint plus socket lifecycle with reconnect and reconcile
(today's `useWorkspaceStream.ts` minus `ref` and `onScopeDispose`), `applyWorkspaceEvent`,
`createCoarseRefresh`, `WorkspaceEventTargets`, and the contribution specs from D4.

Not in it: stores, components, i18n, routing, anything that names a framework. A CI guard fails
the package on an import of `vue`, `nuxt`, `pinia`, `#app` or `#imports`; without it the seam
erodes back into the layer within a few PRs.

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

A new event member arrives as a new OPTIONAL callback, so the seam is additive by construction. An
event with no target logs one stated warning through the injected logger, never a silent drop.
Entity shapes still come from contracts at semver cadence.

This is also where slice F of the extension initiative lands: the `custom` member and the
per-kind handler registration attach to the reducer in app core, so every binding gets consumer
stream events for free and the Vue `onMessage` switch never grows a branch. ADR 0049 named the
fan-out a choke point to leave alone "until a dedicated event-fan-out initiative"; this is that
initiative.

### D4. Every slot entry splits into a JSON-safe spec and a per-binding pairing

`AppSlots` ([`modular/slots.ts`](../../frontend/app/app/modular/slots.ts)) today mixes data and
`Component` references in one object per entry. Following the upstream rule that a component
cannot cross the wire, each slot splits:

| Slot                                                                    | Spec (app core)                                                                       | Pairing (binding)                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `nav`                                                                   | id, label key, group, `NavActionId`, gate predicate inputs                            | icon component, action handler map         |
| `resultViews`, `taskTypeFormPanels`                                     | id                                                                                    | `ComponentEntry` id → component            |
| `inspectorPanels`                                                       | id, order, `when(block)` (already pure in `panels/inspector.logic.ts`)                | `PanelEntry` id → component                |
| `appOverlays`                                                           | id, title key                                                                         | `OverlayEntry` id → component              |
| `taskTypes`, `capabilities`, `externalTools`, `workspaceMetadataFields` | already data                                                                          | none                                       |
| `agentKinds`                                                            | stays in contracts: the backend declares it as a per-workspace `RemoteModuleManifest` | `ComponentEntry` for the result view       |
| `tutorialTours`                                                         | step ids and anchors                                                                  | none needed; a binding may ignore the slot |

The spec resolvers (`resolvePanels`, `resolveComponentRegistry`, `resolveOverlay`) are already
`@modular-frontend/core` exports, so app core re-exports rather than re-implements them. A
consumer registers a spec once and a pairing per binding it ships.

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
`Authorization: Bearer`, and mints stream tickets. The one thing to confirm is that the
return-redirect allow-list (`trip.redirect` in
[`ssoRoutes.ts`](../../backend/packages/server/src/modules/auth/ssoRoutes.ts), gated by
`CORS_ALLOWED_ORIGINS` and `APP_BASE_URL`) accepts a second UI origin. If it does not, the fix is
to that allow-list, not a new token kind.

### D7. A read-only React board is the acceptance test for the seam

Slice 1 is a pure move and proves nothing about the seam on its own. The proof is a small React
app, out of tree, that signs in, hydrates a board through app core, subscribes to the stream, and
implements the targets on a Zustand store. It is done when a run started in the Vue SPA advances
live in the React view with no code in the React app that names an event `type`. What it surfaces
goes into the gotchas section here; what it needs from app core lands as slices.

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
- The Vue SPA's behaviour: slice 1 is a move, and every later slice keeps the Vue binding
  byte-for-byte equivalent for the user.
- `registerAppModule` for Vue consumers: it keeps working, now registering a spec plus a Vue
  pairing.

## Per-slice status

| #   | Slice                                  | Deliverable                                                                                                                                                          | Status | PR  |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 0   | Tracker                                | This document                                                                                                                                                        | done   | —   |
| 1   | Extract `@cat-factory/app-core`        | `frontend/app-core` with client, api modules, token holder, stream lifecycle, reducer, coarse refresh; SPA consumes it; no-framework CI guard; headless stream tests | todo   | —   |
| 2   | Targets seam as the versioned contract | `WorkspaceEventTargets` documented as the stability surface; unknown-event warning; slice F (`custom` member + handler registration) on the reducer                  | todo   | —   |
| 3   | Slot spec / pairing split              | Each `AppSlots` row from D4 split; `registerAppModule` accepts spec + Vue pairing; consumer example updated                                                          | todo   | —   |
| 4   | Read-only React proof (out of tree)    | Sign-in, board hydrate, live stream on a Zustand store; findings recorded here; app-core gaps filed as slices                                                        | todo   | —   |
| 5   | Stability rule written down; ADR       | Semver rule in `contracts` and `app-core` READMEs; `frontend/app/README.md` points at app core; tracker converts to an ADR                                           | todo   | —   |

## Conventions & gotchas (carry between iterations)

- **The reducer stays callback-shaped.** A branch that reaches for a store, even through an
  import, breaks the seam for every binding. Every dependency is a bound callback, the way
  `applyWorkspaceEvent` and `coarseRefresh` already do it.
- **A component reference in app core is a bug**, whatever the framework. If a spec needs to
  select a component, it carries a string id and the binding pairs it.
- **Additive means optional.** A new targets callback is optional with a stated warning when
  absent; a required callback is a major.
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
2. Does the OAuth return-redirect allow-list accept a second UI origin today (D6)?
3. Slice F: agree to land it as the reducer-side registration in app core rather than a branch in
   the Vue `onMessage` switch (D3)?
4. Contribution vocabulary ownership: agent-kind presentation in contracts, everything else in
   app core (D4). Any row that should move?
5. Is the semver rule in D1 acceptable as the whole stability promise for an internal audience, or
   is a written compatibility note per major wanted?

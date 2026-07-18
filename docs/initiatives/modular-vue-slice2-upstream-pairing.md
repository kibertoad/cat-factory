# Upstream request (modular-react / modular-vue): remote-manifest × locally-registered-component pairing

**For:** the modular-react maintainers (`@modular-frontend/*` engine + `@modular-vue/*` bindings + `docs/`).
**From:** the cat-factory frontend team, driving [modular-vue adoption slice 2 ("Result views")](./modular-vue-adoption.md).
**Type:** additive library change (new helper + Vue-binding re-export) **plus** a docs/guide addition. No breaking changes; target a `minor` release of the affected packages.
**Status:** requested — cat-factory slice 2 is **blocked on this being released** (per the initiative's co-evolution rule, we do not ship a local shim that outlives the slice).

> This document is the co-evolution artifact for slice 2: the upstream half of the work,
> written before the cat-factory half so the two land as a matched set. It is deliberately
> self-contained — read it without cat-factory context. The initiative tracker's slice-2 row
> ("Expected upstream workstream: Remote-manifest × locally-registered-component pairing …")
> points here.

---

## 1. Context — the consumer pressure

cat-factory is a Nuxt SPA (`ssr: false`) adopting modular-vue as a phased strangler migration
(slices 0–1 landed: the registry factory in the layer, and a nav/command manifest on
`useReactiveSlots`). Slice 2 converts the app's **result-view registry** — the map of
`agentKind → dedicated detail window` (~18 built-in windows) — from a hardcoded `Record` into a
modular registry, and makes it **extensible by a consumer deployment without forking the layer**.

The app already receives a **backend-delivered capability list** — `customAgentKinds`, an array
of `{ kind, presentation, container }` in the workspace snapshot — which is a hand-rolled version
of exactly the "remote capability manifest" pattern modular-react formalizes. A custom agent
kind's `presentation.resultView` is a **string id** that selects which detail window opens for
that agent's steps.

So slice 2 needs the canonical shape the initiative flagged as an upstream gap:

> **A wire-delivered manifest (data only) whose entries reference, by string id, a component that
> is shipped as code and registered locally by a module (first-party or consumer).**

Components can't cross the network boundary (modular-react already documents this — `component`,
`zones`, `createRoutes` are omitted from `RemoteModuleManifest`). So the manifest carries the
`resultView` **id**, and the component is contributed to a local slot. The host must **pair** the
two by id at render.

This is not cat-factory-specific. Inside cat-factory alone it recurs three times across the
remaining slices — result views (slice 2), inspector panels keyed by block level/type (slice 4),
and agent-run window chrome (slice 5) — and it is a generic "backend lights up a
locally-installed capability" story that any modular-vue consumer with a plugin catalog will hit.

## 2. What the released `@modular-vue/*` gives us today, and exactly where it stops short

We are on `@modular-vue/core@1.0.1`, `@modular-vue/runtime@1.1.0`, `@modular-vue/vue@1.1.0`,
`@modular-vue/nuxt@0.1.1`, `@modular-frontend/core@0.1.0`.

**The two halves both exist:**

- **Local component registry (code):** a module contributes `{ id, component }[]` to a named slot
  via `defineModule({ slots })` / `defineSlots`, and the host reads the concatenated slot with
  `useSlots` / `useReactiveSlots`. ✅ Works today.
- **Remote capability manifest (data):** `RemoteModuleManifest` + `mergeRemoteManifests`, merged
  into slots reactively via a module's `dynamicSlots(deps)` factory reading a reactive service,
  tracked by `useReactiveSlots`. ✅ The primitives exist.

**Where it stops short — three concrete gaps:**

### Gap A — the remote-manifest surface is not reachable through the Vue binding

`mergeRemoteManifests`, `RemoteModuleManifest`, `RemoteNavigationItem`, and
`MergedRemoteManifests` are exported **only from the neutral engine `@modular-frontend/core`**.
The `@modular-vue/{core,runtime,vue}` packages re-export a large slice of the engine
(`buildSlotsManifest`, `buildNavigationManifest`, `evaluateDynamicSlots`, `resolveNavHref` via
core, …) **but not the remote-manifest surface.**

Consequence for a Vue consumer: to use the documented remote-manifest pattern you must import
from `@modular-frontend/core` directly, reaching *past* the binding you were told to program
against. cat-factory has deliberately touched **only** the `@modular-vue/*` binding through slices
0–1 (it's the stable, Vue-shaped seam; the neutral engine is an implementation detail with its
own 0.x cadence). Importing the engine directly for slice 2 is precisely the kind of bend the
co-evolution model says to fix upstream instead of absorbing locally.

> This mirrors [modular-react#87](https://github.com/kibertoad/modular-react/pull/87) (slice 0),
> where the fix was to align the Vue binding's peer surface rather than have cat-factory work
> around it.

### Gap B — no primitive for the id→component join or its validation

Given a merged manifest of data entries (`{ kind, presentation: { resultView: 'x' } }`) and a
component slot (`[{ id: 'x', component: X }]`), **the host has to hand-roll**:

1. building the `Map<id, Component>` from the slot (including **duplicate-id detection** — two
   modules registering the same id should fail loudly, matching the registry's duplicate-module-id
   philosophy);
2. resolving each manifest entry's referenced id against that map;
3. deciding what to do when an id **doesn't resolve** (a manifest names a view no installed module
   provides) — today cat-factory does a dev-only `console.warn` and silently falls back to the
   prose panel. That "silent fallback on a dangling capability reference" is a footgun every
   consumer will re-implement slightly differently.

There is no `resolveComponentRegistry` / `pairById`-shaped helper in the engine or the binding.
Zones are the closest concept but they are **route-driven** (keyed off the active route via
`useRoute().matched` + `meta`), which does not apply to a single-route board app selecting a
component by a **data id**, so they don't fit.

### Gap C — the guide "stops short of" the pairing pattern

`docs/remote-capability-manifests.md` documents merging manifests into slots and the merge-many
vs swap-one topology, but **not** the case where a manifest entry's *field* is a string id that
selects a **code-shipped component registered in a different (local) slot**. It explicitly says
components must "ship as code" but doesn't show the recommended way to then **wire wire-data to
that code** — the id-namespacing, the join, and the missing-id handling. That final hop is the
whole point of "backend lights up a locally-installed view," and it's the documented shape slice 2
needs.

## 3. Proposed upstream changes (additive, `minor`)

Three deliverables. (B) is the substantive one; (A) and (C) are small and make (B) usable and
discoverable.

### 3A. Re-export the remote-manifest surface from the Vue binding

Re-export from `@modular-vue/core` (and thus available to consumers, the same way `defineModule`
etc. are surfaced), from `@modular-frontend/core`:

- values: `mergeRemoteManifests`
- types: `RemoteModuleManifest`, `RemoteNavigationItem`, `MergedRemoteManifests`

so a Vue consumer writes `import { mergeRemoteManifests, type RemoteModuleManifest } from
'@modular-vue/core'` and never reaches into the neutral engine. (If there's a reason to keep the
binding surface minimal, an explicit `@modular-vue/core/remote` subpath export is equally fine —
we only need a Vue-blessed import path.)

### 3B. A framework-neutral component-registry + pairing helper

Add to `@modular-frontend/core` (re-exported from `@modular-vue/core`). The component type `C` is
**opaque** (a Vue `Component`, a React `ComponentType`, anything) so the helper stays in the
neutral engine and both bindings benefit.

```ts
// @modular-frontend/core

/** One code-shipped component contributed to a registry slot, addressed by `id`. */
export interface ComponentEntry<C, TMeta = unknown> {
  readonly id: string
  readonly component: C
  readonly meta?: TMeta
}

export interface ComponentRegistry<C, TMeta = unknown> {
  get(id: string): C | undefined
  has(id: string): boolean
  readonly ids: readonly string[]
  readonly entries: readonly ComponentEntry<C, TMeta>[]
}

/**
 * Index a slot of {@link ComponentEntry} into an id→component registry.
 * Duplicate ids THROW by default (mirroring duplicate-module-id validation) — two modules
 * claiming the same view id is a bug, not a silent last-wins. `onDuplicate: 'last-wins'`
 * / `'first-wins'` opt out when a deployment intentionally overrides a first-party id.
 */
export function resolveComponentRegistry<C, TMeta = unknown>(
  entries: readonly ComponentEntry<C, TMeta>[],
  opts?: { onDuplicate?: 'throw' | 'last-wins' | 'first-wins' },
): ComponentRegistry<C, TMeta>

/**
 * Pair a list of manifest data entries with the registry by id, collecting the ones whose
 * referenced id has no registered component so the host handles a dangling reference
 * explicitly (warn / fallback / drop) instead of a silent miss.
 */
export function pairById<T, C, TMeta = unknown>(
  items: readonly T[],
  registry: ComponentRegistry<C, TMeta>,
  idOf: (item: T) => string | undefined,
): {
  readonly paired: readonly { item: T; id: string; component: C }[]
  readonly missing: readonly { item: T; id: string }[]
  /** items whose `idOf` returned undefined — no view requested (e.g. use the generic panel) */
  readonly unref: readonly T[]
}
```

Notes / semantics:

- **Framework-neutral & reactivity-neutral.** Both functions are pure over their inputs. In Vue,
  the host calls them inside a `computed` fed by `useReactiveSlots()` + the reactive manifest
  service, so they re-run when the slot set or the backend manifest changes — no special support
  needed. Keeping them pure is what lets the same helper serve the React family.
- `resolveComponentRegistry` default-throws on duplicate id — the loud-failure default matches the
  registry's existing duplicate-id stance; the `last-wins`/`first-wins` escape hatch is for a
  deployment that *intends* to shadow a first-party view.
- `pairById`'s three-bucket return (`paired` / `missing` / `unref`) is deliberately explicit so the
  host can, e.g., dev-`warn` on `missing`, render nothing (or a fallback) for them, and route
  `unref` items to a default panel — without every consumer re-deriving that partition.

**Optional, only if cheap:** a `RegistryPlugin` (`componentPairingPlugin({ componentSlot,
staticRefs })`) whose `validate(ctx)` fails `resolveManifest()` when a **statically-registered**
manifest references an id absent from the component slot. This only covers refs known at
resolve-time (not async remote manifests), so it's a nice-to-have, not required — `pairById`'s
`missing` bucket is the runtime counterpart that covers the async case. Ship it only if it's a
small addition on top of the existing plugin machinery.

### 3C. Guide section: "Pairing wire-safe manifests with code-shipped components"

Add a section to `docs/remote-capability-manifests.md` covering:

- **The shape:** a manifest entry field (`viewId`, `panelId`, …) is a string id; the component for
  that id is contributed by a local module to a separate component-registry slot; the host pairs
  them with `resolveComponentRegistry` + `pairById`.
- **Why:** components can't cross the wire; this is the sanctioned way to let backend data light up
  a locally-installed component (first-party or consumer).
- **Id namespacing:** first-party ids are bare (`requirements-review`); a consumer's own view ids
  SHOULD be namespaced (`acme:security-report`) so a consumer view can't collide with — or be
  intended to shadow — a first-party one. Document the `onDuplicate` policy alongside this.
- **Missing-reference handling:** show handling the `missing` bucket (dev-warn + generic fallback)
  as the recommended default, so "backend names a view this build doesn't ship" degrades
  predictably rather than crashing or silently disappearing.
- Cross-link from the framework-mode-nuxt guide's consumer-seam section (added in slice 0).

## 4. How cat-factory will consume it (so the API is validated against a real shape)

Once released, slice 2 lands on the cat-factory side as:

1. A first-party **result-views module** contributes `ComponentEntry<Component>[]` (the ~18
   built-in windows) to a `resultViews` slot. A consumer deployment contributes its own entries to
   the same slot via the existing `registerAppModule(...)` seam — no layer fork.
2. `StepResultViewHost.vue` replaces its hardcoded `Record` with
   `resolveComponentRegistry(useReactiveSlots().value.resultViews)` and renders
   `registry.get(activeViewId)`. The current hand-rolled dev-warn becomes `pairById`'s `missing`
   bucket.
3. The snapshot's `customAgentKinds` becomes a **`RemoteModuleManifest`** fed through
   `mergeRemoteManifests` (imported from `@modular-vue/core`, per 3A) inside a `dynamicSlots`
   factory reading a reactive `capabilities` service — replacing today's `registerCustomKinds`
   **mutation of the module-global `AGENT_BY_KIND`**. `agentKindMeta` reads the merged reactive
   catalog; the mutation is deleted.
4. A custom kind's `presentation.resultView` (a string id in the manifest) is paired against the
   `resultViews` registry via `pairById` — the exact remote-data-selects-a-local-component join
   this request formalizes.

The one change that stays entirely on cat-factory's side (noted here only so upstream sees the
full end-to-end): our backend currently validates `presentation.resultView` against a **closed
picklist** of built-in ids, so a consumer can't yet declare a *new* view id over the wire. Opening
that validation to consumer-namespaced ids is a cat-factory backend change and is **not** part of
this upstream request — but it's why the `onDuplicate` policy and id-namespacing guidance in 3C
matter to us.

## 5. Acceptance criteria

- `import { mergeRemoteManifests, type RemoteModuleManifest } from '@modular-vue/core'` type-checks
  and works at runtime (3A).
- `resolveComponentRegistry` throws on a duplicate id by default; `last-wins`/`first-wins` honor
  the override; `get`/`has`/`ids`/`entries` behave as specified. Unit-tested.
- `pairById` partitions into `paired` / `missing` / `unref` correctly, including the
  `idOf → undefined` case. Unit-tested.
- Both helpers are pure and framework-agnostic (a Vue `computed` re-runs them on reactive change
  with no library-specific glue — demonstrate in a Vue test).
- `docs/remote-capability-manifests.md` has the pairing section (3C), cross-linked from the
  Nuxt consumer-seam docs.
- No breaking changes; released under a `minor` label on the touched packages
  (`@modular-frontend/core`, `@modular-vue/core`, and any binding that re-exports the surface).

## 6. Out of scope

- Route-driven zones (cat-factory is single-route; slice 2 is a data-id → component registry, not a
  route zone).
- Sending components over the wire (correctly forbidden; this request is precisely the sanctioned
  alternative).
- The cat-factory backend picklist change (§4) — cat-factory-local.
- The resolve-time validation plugin is optional (§3B) — `pairById`'s runtime `missing` bucket is
  the required path for async remote manifests.

---

*When this is released, bump the `@modular-vue/*` pins in `frontend/app/package.json`, then land
the cat-factory slice-2 side described in §4 and close the slice-2 row in the tracker.*

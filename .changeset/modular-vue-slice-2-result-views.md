---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
---

Adopt modular-vue in the Nuxt layer (slice 2: result views + custom-kind
manifests). The dedicated result-view registry is no longer a hardcoded `Record`
in `StepResultViewHost.vue`: every built-in window is contributed to a modular
`resultViews` slot (`app/modular/result-views.ts`), and the host reads the merged
slot through `useReactiveSlots` and indexes it with `@modular-vue/core`'s
`resolveComponentRegistry` / `pairById`. A consumer deployment ships its OWN
result window by contributing a `{ id, component }` entry to the same slot via
`registerAppModule` — it mounts with no host edits, paired against the kind's
`presentation.resultView` id (the sanctioned "backend data selects a
code-shipped, locally-registered component" pattern).

The deployment's custom agent kinds now flow through the modular system instead
of mutating a module-global catalog: the frozen built-in `AGENT_BY_KIND` const is
never written to, backend-registered kinds are modeled as a per-workspace
`RemoteModuleManifest` (`hydrateCustomKinds`), CODE-shipped consumer kinds enter
via a static `agentKinds` slot (`registerConsumerKinds`), and the agents store
projects the merged catalog into a reactive read-model so `agentKindMeta` /
`isKnownAgentKind` resolve custom kinds. `registerCustomKinds` (which mutated the
global) is removed. Note a deliberate tightening: a custom kind whose id collides
with an engine system/gate kind (`ci` / `merger` / `blueprints` / …) is now
dropped from the palette, not just one colliding with a built-in — matching the
`agentKindMeta` precedence where such a kind never won anyway. The per-workspace
manifest carries a content-derived version so an unchanged snapshot re-hydrate
(which recurs on every board refresh) is a no-op instead of re-invalidating every
`agentKindMeta` consumer, and built-in result-view coverage is now a compile-time
invariant (`Record<ResultViewId, Component>`) rather than a runtime dev warning.

`@cat-factory/contracts`: `agentPresentationSchema.resultView` is opened from a
closed built-in picklist to also accept a consumer-namespaced id (`<ns>:<name>`,
e.g. `acme:security-report`), so a backend-registered custom kind can select a
consumer-registered frontend view. A bare id that is not a built-in still fails
validation (the typo guardrail); the boot-time registration validator accepts the
same shape.

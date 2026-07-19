# `@cat-factory/gates` — the built-in polling-gate suite

The platform's own gates (`ci`, `conflicts`, `post-release-health` + the `on-call` escalation),
authored **entirely through the public gate-registry seam** — kernel + contracts only, never
the engine. This is the dogfood: the built-in gates ARE an external package.

**Entry:** `src/index.ts` — exposes `gateRegistryWithBuiltins()` (the one-call factory a
composition root reaches for: a fresh app-owned `GateRegistry` pre-loaded with the suite, which
the facade threads through `CoreDependencies.gateRegistry` — there is NO module-load side effect)
and its lower-level building block `registerBuiltinGates(gateRegistry)` (installs the suite into
an existing instance — used when a caller already holds an injected registry to override), plus
the `wireCiStatusProvider` / `wireMergeabilityProvider` / `wireReleaseHealthProvider` /
`wireIncidentEnrichment` handles a facade calls to plug in each gate's provider (a gate is a
pass-through until its provider is wired). Prefer `gateRegistryWithBuiltins()` over the
`defaultGateRegistry()` + `registerBuiltinGates()` two-step: kernel's `defaultGateRegistry()` is
empty by design, so a site that forgets the second step silently drops the platform's gates.

**Key files:** `gates.ts` (the `GateDefinition`s), `providers.ts` (the provider-wiring handles),
`review.logic.ts`.

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)"; kernel `domain/gate-logic.ts`
(the pure gate logic the engine drives); `backend/docs/custom-agent-gate-ergonomics.md`.

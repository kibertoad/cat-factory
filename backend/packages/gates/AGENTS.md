# `@cat-factory/gates` — the built-in polling-gate suite

The platform's own gates (`ci`, `conflicts`, `post-release-health` + the `on-call` escalation),
authored **entirely through the public gate-registry seam** — kernel + contracts only, never
the engine. This is the dogfood: the built-in gates ARE an external package.

**Entry:** `src/index.ts` — exposes `registerBuiltinGates(gateRegistry)` (which a facade calls to
install the suite into the app-owned `GateRegistry` it threads through
`CoreDependencies.gateRegistry` — there is NO module-load side effect) plus the
`wireCiStatusProvider` / `wireMergeabilityProvider` / `wireReleaseHealthProvider` /
`wireIncidentEnrichment` handles a facade calls to plug in each gate's provider (a gate is a
pass-through until its provider is wired).

**Key files:** `gates.ts` (the `GateDefinition`s), `providers.ts` (the provider-wiring handles),
`review.logic.ts`.

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)"; kernel `domain/gate-logic.ts`
(the pure gate logic the engine drives); `backend/docs/custom-agent-gate-ergonomics.md`.

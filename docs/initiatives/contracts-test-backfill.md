# Initiative: contracts parse-boundary test backfill

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

`backend/packages/contracts` is the trust boundary of the whole system — the Valibot wire
schemas plus the hand-written parse/normalize/default logic every ingest path relies on
(`parseBlueprintService`, `parseInitiativePreset`, `parseAccountSettingsConfig` /
`parseAccountSettingsSecrets` / `accountSettingsSummary`, the service-connection indexing,
requirement-review shapes, step-options bags, …). It currently has **142 source files and
zero test files**. These are exactly the branchy pure functions on untrusted input where a
regression means *silent* data loss or acceptance of malformed state — the schema quietly
drops a field, a default flips, a lenient coercion widens — and nothing downstream notices
until a run behaves wrongly. Downstream suites (conformance, worker/node integration)
exercise happy paths incidentally; nothing pins rejection behaviour, defaulting, or
normalization edge cases at the boundary itself.

This is the highest-leverage, lowest-risk reliability project on the board: pure functions,
no infra, no mocks, fast vitest — and it protects every other initiative that touches a
wire shape.

Scope note: this backfills tests for the **contracts package**; per-strategy tests for the
similarly-thin `consensus` package are a natural sibling slice (3 voting strategies, 1
spec) and are included as the final row rather than a separate tracker.

## Target pattern

1. **Test the exported behaviour, not the schema internals**: for each parse/normalize
   entry point — (a) canonical valid input round-trips with expected defaults applied,
   (b) each *class* of invalid input is rejected (or leniently coerced, where that is the
   documented intent — pin whichever it is), (c) unknown keys / extra fields behave as
   intended (stripped vs rejected), (d) boundary values on unions/enums/lengths.
2. **Prioritize by blast radius**, not file order: ingest-side parsers that accept
   agent/LLM- or user-authored blobs first (`parseBlueprintService`,
   `parseInitiativePreset`, account-settings config/secrets, service-connections indexing,
   step-options), then wire schemas the public API exposes, then internal-only shapes.
3. **Property-ish fuzz where it pays**: for the lenient coercion paths (the blueprint
   coerce-then-validate pipeline), a small randomized-mutation pass (drop/retype/null a
   field, assert "parses cleanly or throws — never returns a half-shape") catches the class
   of bug example-based tests miss. Keep it seeded/deterministic — no `Math.random()` in
   committed tests without a fixed seed.
4. **Plumbing**: the package needs a vitest setup (`test:run` script + config) matching the
   other leaf packages (copy the nearest good citizen, e.g. `packages/gates`); Turbo picks
   it up via the root `test:run`. Pure-logic tests only — no DB, no runtime.

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | Vitest scaffolding for `@cat-factory/contracts` + pilot spec (`parseBlueprintService`: valid/lenient-coerce/reject/never-half-shape) | ⬜ todo | |
| 2 | Account settings: `parseAccountSettingsConfig` / `parseAccountSettingsSecrets` / `accountSettingsSummary` (incl. secret-redaction behaviour of the summary) | ⬜ todo | |
| 3 | `parseInitiativePreset` + initiative shapes | ⬜ todo | |
| 4 | Service-connections indexing + entities defaults/normalization | ⬜ todo | |
| 5 | Requirements/review, step-options, merge-preset shapes | ⬜ todo | |
| 6 | Public-API projections (`publicTask`/`publicService`/`publicJob` + route contracts) — no credential-bearing field can slip into a projection | ⬜ todo | |
| 7 | Seeded fuzz/mutation pass over the lenient-coercion parsers | ⬜ todo | |
| 8 | Sibling: per-strategy tests for `@cat-factory/consensus` (`debate`, `rankedVoting`, `specialistPanel`, `gating`) | ⬜ todo | |

## Conventions & gotchas

- **Pin current behaviour before "fixing" it.** Where a test reveals a surprising
  lenient/strict choice, the first PR pins what IS; changing the behaviour is a separate,
  visible commit (possibly a flagged breaking change in the changeset) — never a silent
  by-product of adding tests.
- **Tests are excluded from build configs** — run them via `pnpm exec turbo run typecheck
  --filter=@cat-factory/contracts` + the root `test:run`, per the repo convention that
  typecheck covers tests.
- **Changesets**: test-only slices take an empty changeset; any slice that also changes a
  schema's behaviour needs a real one (contracts is a published package consumed by the
  SPA).
- **No snapshot dumps of whole schemas** — assert the specific fields/decisions a reader
  can review; giant snapshots rot and approve themselves.
- Keep fixtures inline and minimal; a fixture file forest for pure parsers is overhead
  without payoff.

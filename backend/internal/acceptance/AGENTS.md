# `@cat-factory/acceptance`: the live-deployment acceptance suite

Bootstraps two empty repositories, ships a cross-service feature onto a real k3s ephemeral
environment, then investigates and fixes the defect that feature leaves behind, against a LIVE
local deployment with nothing faked. Full notes: [`README.md`](./README.md).

**Entry:** `acceptance/*.acceptance.ts` via
`pnpm --filter @cat-factory/acceptance run acceptance`. Needs a running deployment, a k3s cluster
and real model credentials; `src/config.ts` refuses with the whole list of what is missing.

**It is NOT in CI and must never become so.** `test:run` points at `vitest.config.ts`, which
collects `test/**/*.test.ts` only: this package's own unit tests. The acceptance specs are behind
`vitest.acceptance.config.ts`, which nothing but the `acceptance` script names. Adding
`acceptance/` to the default include would put real model spend and a cluster requirement into
every CI lane.

**Where things live**

| File                          | What                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `acceptance/00-preflight`     | The key, the catalog, a real apiserver probe. Creates nothing.                   |
| `acceptance/01-bootstrap`     | k3s engine + two bootstrapped repos + each service's manifest source.            |
| `acceptance/02-feature-…`     | `pl_build` across both services; environment / CI / merge evidence.              |
| `acceptance/03-investigate-…` | `pl_bugfix`; the `clarity-review` gate answered over `/api/v1`; the repro proof. |
| `src/`                        | The harness. Per-file roles are tabled in the README.                            |
| `test/`                       | Unit tests for the pure logic (config, ledger, evidence, waits). CI-safe.        |

**The four rules the specs are written to** (each expanded in the README, and each the reason a
particular file exists):

1. **Assert on evidence the platform COMPUTED, never on agent prose.** `src/evidence.ts` reduces
   the verification report; grepping a coder's reply tests the model's phrasing, not the product.
2. **Never auto-answer an unplanned decision.** `src/decisions.ts` answers `follow-ups` and
   `clarity-review` and hard-fails on everything else, naming the kind. A loop that settles
   whatever it finds drives a run past decisions a person was meant to make and still ends `done`.
3. **A wait that expires states its last observation.** The vitest timeout is off so
   `src/deadline.ts` fires first.
4. **Report every failing claim, not just the first.** A pass costs an afternoon.

**The defect spec 03 hunts is planted in the SPECIFICATION, not the code.** The two briefs in
`src/instructions.ts` disagree about whether pagination offsets are 0- or 1-based; each service is
correct against its own brief and passes its own review, so the mismatch survives to production the
way a real integration bug does. A defect planted in the implementation would be caught by
`pl_build`'s `reviewer` step and spec 03 would find nothing. **So spec 02 asserts the delivery
machinery worked, never that the product is correct**. That claim is spec 03's, and it is settled
by fixing the bug.

**Changing a brief means re-checking the symptom.** The briefs, the bug report and
`test/evidence.test.ts` describe one specific off-by-one (page 2 repeats item 10, last page short).
Edit the pagination rules and that trace changes, so the bug report has to change with them or the
investigator is handed a symptom the code does not produce.

**Setup uses three app-API calls on purpose**, each documented at the top of `src/appApi.ts`:
repo bootstrap, the infra handler, and a block's `provisioning`. Everything else (tasks, starts,
decisions, run projections, evidence) goes through the published SDK. If a future change puts one
of those three on `/api/v1`, delete it from `appApi.ts` rather than keeping both.

**See also:** [`backend/internal/e2e`](../e2e/README.md),
[`backend/internal/sdk-smoketest`](../sdk-smoketest/README.md),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).

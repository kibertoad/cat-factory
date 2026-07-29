---
'@cat-factory/executor-harness': patch
---

Run the executor-harness and smoketest-harness unit suites in CI.

The unit lane is `pnpm -r run test:run`, and neither package defined that alias — so 560
executor-harness tests and 15 smoketest-harness tests had never run in CI. Their
`benchmark-harness` / `deploy-harness` siblings each carry an alias identical to their own `test`
script for exactly this reason, and there is no history of it being removed from either laggard,
so this reads as an omission rather than a decision.

Only `test:acceptance` ran before, in the Container acceptance lane, which covers the Docker
end-to-end path and none of the unit surface: the watchdogs, the failure classifier, the
call-metric aggregator, git auth/checkout/PR, redaction, the progress guard, validation and the
reproduction proof.

Both default vitest configs are already unit-only and offline (`include: ['test/*.test.ts']`, with
the Docker suite in its own config), so they belong in that lane as-is.

`package.json` is an executor image source, so the harness version and its three pins move with
it — no source under `src/` changed, so the new image is byte-identical in behaviour to the one
it replaces.

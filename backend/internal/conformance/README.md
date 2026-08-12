# @cat-factory/conformance

The cross-runtime behaviour suite: `defineConformanceSuite(harness)` states the key backend
behaviour as runtime-neutral assertions parameterised by a `ConformanceHarness`, and each facade
runs the same assertions against its own persistence. A repository that maps a column differently,
or an engine path only one facade wires, fails a test instead of shipping.

## Running it, when your change touched a suite file

Nothing here executes on its own. `src/suites/*.ts` are libraries; the runnable entry points are the
facade specs that call them:

| Facade     | Entry point                                                                | Needs              |
| ---------- | -------------------------------------------------------------------------- | ------------------ |
| Cloudflare | `backend/runtimes/cloudflare/test/integration/conformance.<group>.spec.ts` | workerd + local D1 |
| Node       | `backend/runtimes/node/test/conformance.<group>.spec.ts`                   | a real Postgres    |
| Local      | `backend/runtimes/local/test/conformance.<group>.spec.ts`                  | a real Postgres    |

Every facade now splits the suite per group (`defineExecutionConformance` and its siblings), each
spec importing its facade's harness module, so the largest group is the long pole of a parallel run
rather than serialised behind the rest. The Worker used to run the whole suite from one spec, and
that one file grew to 533 of its package's ~1400 tests: vitest's `--shard` slices by FILE COUNT, so
no split of the lane could balance it and its shard came within 41 seconds of the 15-minute cap.
`defineConformanceSuite` (the aggregate) is still exported and still what a NEW facade should reach
for first. A Postgres group's spec `describe.skip`s itself when `DATABASE_URL` is unset, so a run
with no database is green and proves nothing.

**Adding a group means adding a spec file to all three facades**, and
`scripts/check-conformance-group-parity.mjs` (CI's `repo-guards` job) fails until you have: it
requires every `define…Conformance` exported here to be called by the aggregate and by a spec on
each facade. Nothing else can see that gap — a facade missing a group runs its remaining groups
green, and assertions that never execute read exactly like assertions that passed.

**Run the Cloudflare one.** It needs no database, so it works on a machine with nothing set up, and
it covers the same assertions. `CLAUDE.md` bans reaching for a package lane to check nothing else
broke, and a suite edit is not the exception: name the spec for the group you touched on the command
line (`conformance.core`, `.agents`, `.integration`, `.execution`, `.misc`, `.cache`).

```sh
pnpm exec turbo run build --filter=@cat-factory/conformance   # see below, this is not optional
cd backend/runtimes/cloudflare && pnpm exec vitest run test/integration/conformance.execution.spec.ts
```

**The build step is the trap.** The facade specs import this package's BUILT output, so an unbuilt
edit runs the PREVIOUS suite and reports green about code that was never executed. The same applies
in reverse: a green run right after editing a suite, with no rebuild between, proves nothing.

For the Postgres facades (only when the behaviour is genuinely store-specific), stand a cluster up
per [`running-tests.md`](../../../docs/internal/running-tests.md) first.

**A `kernel/src/domain/seed.ts` catalog edit runs the same spec**, plus `pipelineShape.test.ts` and
`seed.test.ts`. It has the same problem from the other direction: its blast radius lands in files
nowhere near it, so "run the files your change touched" has nothing to name. What the built-in
catalog owes each of those suites is in
[`pipeline-catalog-lifecycle.md`](../../docs/pipeline-catalog-lifecycle.md).

## Adding to a suite

- **Assert BEHAVIOUR, not a facade's internals.** Anything asserted here has to be true on D1 and on
  Postgres, so it goes through `app.call` (the facade's real Hono app) or the harness's declared
  seams, never a runtime's own repository class.
- **A new harness capability is a `ConformanceHarness` / `ConformanceApp` member implemented by
  EVERY facade** (`runtimes/cloudflare/test/integration/conformanceHarness.ts`,
  `runtimes/node/test/harness.ts`, `runtimes/local/test/harness.ts` and its mothership sibling). A
  member one facade leaves out is a parity hole the suite can no longer see.
- **Seed state through the API a user would use.** The exception is state a user can no longer
  author: `seedLegacyPipeline` writes a pipeline shape the save boundary now refuses, because the
  engine still has to handle the rows that predate the rule. Reaching for it to skip a validation
  that WOULD accept your shape is how a suite stops testing the product.
- **A suite about a row NO write path may produce rides a RAW seed seam instead**, and says so:
  `defineUndecodableRunSuite` needs an `agent_runs` row the write-side guard now refuses to compose,
  so it seeds through `PlatformMetricsSeed` (shared with `definePlatformMetricsSuite`, whose entry
  points are the two `platform-metrics.spec.ts` files rather than the table above). That is the
  narrow case: a raw seam reached for anything the API can author is the previous bullet's trap.

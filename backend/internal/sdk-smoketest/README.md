# `@cat-factory/sdk-smoketest`

The **cross-SDK smoketest**: boots a real Node backend, then drives the same scenario through all
four public-API SDK clients ([`sdk/`](../../../sdk)) and compares their observation reports field
by field. A second phase spawns the published **MCP server** against the same backend.

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cat_factory_test \
  pnpm --filter @cat-factory/sdk-smoketest run smoketest

# while iterating on one client:
DATABASE_URL=... pnpm --filter @cat-factory/sdk-smoketest run smoketest -- --only=go

# just the MCP facade (needs `pnpm build` first, for sdk/mcp/dist/bin.js):
DATABASE_URL=... pnpm --filter @cat-factory/sdk-smoketest run smoketest -- --only=mcp

# the Cloudflare OS Gatekeeper against this deployment (not part of the everything run):
DATABASE_URL=... pnpm --filter @cat-factory/sdk-smoketest run smoketest -- --only=gatekeeper
```

## What it is for

**The comparison, not the individual runs.** A per-SDK test can only assert that a client matches
what its own author expected. Four reports compared against each other catch the class of bug this
SDK family is most exposed to: one language decoding a field differently, mapping a refusal to
the wrong error class, dropping a null, or paginating one page short, because those show up as a
DISAGREEMENT even when nobody wrote down what the right answer was.

It earned that immediately: the Java client's default HTTP/2 was sending an h2c upgrade on
cleartext connections that the Node facade answered with a **404 on every call**. Three other
SDKs agreeing is what made it obvious that the fault was in the client, not the deployment.

## How it runs

1. **Boot** the REAL Node facade by spawning `@cat-factory/e2e`'s `testServer.ts`: the same
   shared Hono app, real Postgres, real pg-boss, with only the LLM/agent side faked. Reusing the
   e2e server rather than composing a second wiring is deliberate: a smoketest against a bespoke
   composition would prove the SDKs work against _that_, and the wiring is the likeliest thing to
   drift.
2. **Seed**, per SDK, a FRESH account-backed workspace over the test control channel, plus an
   `admin` key (the scenario deletes a task) and a `read` key (so it can observe a typed
   `insufficient_scope` refusal). Fresh per SDK because a shared workspace would make each
   client's observations depend on what the previous ones left behind.
3. **Run** each SDK's `smoketest/` program with `CAT_FACTORY_BASE_URL`, `CAT_FACTORY_API_KEY`,
   `CAT_FACTORY_READ_KEY` and `CAT_FACTORY_SMOKETEST_OUT`. Each writes a JSON report.
4. **Compare** the reports (`src/parity.ts`).

## The scenario

List services and pipelines → create, edit and read a task → page it one item at a time, both
manually and auto-paged → read usage and notifications → provoke a **404**, a **401** and a
**403 `insufficient_scope`** → start the task → read its SSE stream → read the run projection →
stop it → delete it and confirm it is gone.

Each SDK's program is told to **OBSERVE and RECORD, never assert**: an assertion fails one client
in isolation, where a recorded observation is comparable across four.

## The comparison

Three kinds of problem, and all of them are reported (not just the first: divergences usually
share one root cause and reading them together is what shows it):

- **`expectation`**: an absolute claim every SDK must satisfy (`notFoundStatus` is 404,
  `forbiddenCode` is `insufficient_scope`, `pagedHasDuplicates` is false). Catches all four being
  wrong the same way, which a purely comparative check cannot see.
- **`disagreement`**: the SDKs observed different values for the same thing.
- **`missing`**: some SDKs recorded an observation and others did not.

A small `ENVIRONMENTAL` allow-list covers observations that may legitimately differ (how far a
run had progressed when each client looked). Every entry there is a place a real divergence would
go unreported, so the bar for adding one is "these two SDKs cannot be expected to observe the same
value", never "these numbers move around".

## The MCP phase

`src/mcp.ts` spawns `sdk/mcp/dist/bin.js` as a real process and speaks the protocol to it. It is
**graded, not compared**: there is one implementation, so every check is an absolute claim, and the
phase reuses the parity module's problem vocabulary only so the two report the same way.

It exists for the half of that package no unit test can reach: the part that only exists once there
is a PROCESS:

- **It starts from environment variables alone**, including `CAT_FACTORY_API_KEY_FILE` (the
  mitigation for a long-lived key sitting in a host's plaintext config), and exits **1** with the
  configuration named when it cannot work.
- **Stdout stays free for JSON-RPC.** A single human-readable byte on it corrupts the stream, so the
  ready banner is asserted on stderr and stdout is asserted empty on the failing path.
- **The published `outputSchema`s are validated against real responses.** A tool declaring one is
  obliged to return `structuredContent`, and the MCP client validates it, so this is the only check
  in the repo that can see the generated schemas disagree with what the deployment actually answers.
- **The env-only tool filters are honoured**, which only a process that read the environment can
  demonstrate.

A missing `dist/bin.js` is a **failure naming the build command**, not a skip: the artifact is ours
rather than a language toolchain, so there is nothing to conclude from its absence.

## The Gatekeeper phase

`src/gatekeeper.ts` points the **Cloudflare OS Gatekeeper Worker**
([`sdk/gatekeeper-worker`](../../../sdk/gatekeeper-worker)) at this backend and runs that package's
`test/live` specs in real workerd, with no outbound service, so every call the Worker makes leaves
the isolate and lands on the deployment.

It exists for the half of that package its own suite structurally cannot reach. The hermetic run
binds a SCRIPTED cat-factory as the pool's outbound service, which is what makes it fast and
deterministic and is also why it can never disagree with the package: the fixture was written from
the same reading of the surface. A request shape the generated bindings and the SDK both consider
correct therefore round-trips there and fails for the first time in somebody's production. This
phase is where it fails here instead: the enrolment's notification-type vocabulary, a per-actor key
mint and its 401 recovery, the everyday loop's bodies, and a real run answered off a real decision
list through the card the platform's own notification raises.

Three things are worth knowing before changing it:

- **The claims live in the specs**, not here: they need workerd and a Cap'n Web session. What this
  module grades is that the suite RAN and that everything in it passed, read from vitest's JSON
  report rather than the exit code alone, because a suite that collected nothing also exits 0.
- **The workspace is asked to PARK.** `startBackend` clears `E2E_DECISION_ON_STEPS` for every other
  phase; this one sets `decisionOnSteps: [0]` for its own workspace over the control channel. A
  Gatekeeper cannot be smoketested against a deployment that never parks a run.
- **It is asked for by name.** CI runs it in the Gatekeeper's own non-blocking lane, where a
  partner-side protocol still in motion cannot red this repo's required checks, so the everything
  run reports it as NOT RUN rather than leaving the section out.

## Notes

- A missing language toolchain is **skipped loudly**, and in CI (`SDK_SMOKETEST_REQUIRE_ALL`) it
  fails: a silent skip is indistinguishable from a pass.
- Fewer than two reports is not a parity check, and the run says so rather than reporting the
  vacuous "0 disagreements".
- `E2E_DECISION_ON_STEPS` is cleared: the e2e suite defaults it so every run parks once on a
  human decision, which would park the smoketest's run before it produced any progress.

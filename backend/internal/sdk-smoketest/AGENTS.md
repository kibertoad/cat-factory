# `@cat-factory/sdk-smoketest`: the cross-SDK parity harness

Boots a real Node backend and drives the SAME scenario through all four SDK clients
([`sdk/`](../../../sdk)), then compares their observation reports. A second phase spawns the published
MCP server (`sdk/mcp`) against the same backend. Full notes: [`README.md`](./README.md).

**Entry:** `src/run.ts`: `pnpm --filter @cat-factory/sdk-smoketest run smoketest` (needs
`DATABASE_URL`; `--only=<sdk>` narrows to one while iterating, `--only=mcp` to the MCP phase,
`--only=gatekeeper` to the Gatekeeper phase, which is the one NOT in the everything run).

**Where things live**

| File                | What                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/run.ts`        | the loop: boot → MCP phase → seed per SDK → run → compare → exit code                                 |
| `src/backend.ts`    | spawning `@cat-factory/e2e`'s `testServer.ts` and seeding an account-backed workspace + the two keys  |
| `src/runners.ts`    | one entry per language: toolcheck, optional build, and how to invoke its program                      |
| `src/parity.ts`     | the comparison; `EXPECTED` (absolute claims) and `ENVIRONMENTAL` (may legitimately differ)            |
| `src/mcp.ts`        | the MCP phase: spawn `sdk/mcp/dist/bin.js`, drive it over stdio, grade against `MCP_EXPECTED`         |
| `src/gatekeeper.ts` | the Gatekeeper phase: park this workspace, run `sdk/gatekeeper-worker`'s `test/live` specs in workerd |

Each SDK's own program lives beside that SDK (`sdk/*/smoketest/`), so it is written in the
language it exercises and can only use that client's public API.

**The rule for the per-SDK programs: OBSERVE and RECORD, never assert.** An assertion fails one
client in isolation; a recorded observation is comparable across four, and the comparison is the
whole point of this harness.

**Adding a scenario step means adding it to ALL FOUR programs** with the same observation keys:
`parity.ts` reports a key some SDKs recorded and others did not as a `missing` problem, so a
half-done addition fails rather than silently narrowing the check.

**The MCP phase is GRADED, not compared**, because there is only one implementation of it: every
check is an absolute claim in `MCP_EXPECTED`, and it does not join `compareReports`. Its reason for
existing is what only a spawned PROCESS shows: startup from the environment alone (including the key
FILE), stdout kept free for JSON-RPC, the exit code, the env-only tool filters, and the published
`outputSchema`s validated by a real client against real responses.

**The Gatekeeper phase runs someone else's specs, and grades only that they RAN and passed.** Its
subject is a CONSUMER of the surface (`@cat-factory/gatekeeper-worker`), which needs workerd and a
Cap'n Web session, so the claims live in that package's `test/live` specs where those exist. This
harness supplies what only it has: the boot, the seeded workspace, the `admin` provisioning key, and
the per-workspace park profile a Gatekeeper's whole reason for existing depends on. It is asked for
by NAME rather than being part of the everything run, because CI runs it in the Gatekeeper's own
non-blocking lane; the summary prints it as not run rather than omitting the section.

**Grading "they ran" is read off the JSON report's PER-ASSERTION statuses, never its totals or the
exit code.** Both of those call a suite that asserted nothing a pass: an empty run exits 0, and a
fully skipped one exits 0 with a full `numTotalTests`. `summariseVitestReport` and `gradeSuiteRun`
are split out of the spawn and unit-tested (`test/gatekeeper.test.ts`) for exactly that reason: a
bug in this reduction reports green and nothing else notices. For the same reason every way the
child can go wrong becomes a failure STRING carrying its output rather than a throw, which `run.ts`
would let escape past the summary.

**See also:** `sdk/README.md` (the SDK family and its design rules), `backend/internal/e2e`
(whose test server this boots), `backend/docs/public-api.md`.

# `@cat-factory/sdk-smoketest`: the cross-SDK parity harness

Boots a real Node backend and drives the SAME scenario through all four SDK clients
([`sdk/`](../../../sdk)), then compares their observation reports. A second phase spawns the published
MCP server (`sdk/mcp`) against the same backend. Full notes: [`README.md`](./README.md).

**Entry:** `src/run.ts`: `pnpm --filter @cat-factory/sdk-smoketest run smoketest` (needs
`DATABASE_URL`; `--only=<sdk>` narrows to one while iterating, `--only=mcp` to the MCP phase).

**Where things live**

| File             | What                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `src/run.ts`     | the loop: boot → MCP phase → seed per SDK → run → compare → exit code                                |
| `src/backend.ts` | spawning `@cat-factory/e2e`'s `testServer.ts` and seeding an account-backed workspace + the two keys |
| `src/runners.ts` | one entry per language: toolcheck, optional build, and how to invoke its program                     |
| `src/parity.ts`  | the comparison; `EXPECTED` (absolute claims) and `ENVIRONMENTAL` (may legitimately differ)           |
| `src/mcp.ts`     | the MCP phase: spawn `sdk/mcp/dist/bin.js`, drive it over stdio, grade against `MCP_EXPECTED`        |

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

**See also:** `sdk/README.md` (the SDK family and its design rules), `backend/internal/e2e`
(whose test server this boots), `backend/docs/public-api.md`.

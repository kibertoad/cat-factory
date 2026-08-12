---
'@cat-factory/acceptance': minor
---

Run the acceptance scenarios from a plain Node entry point instead of vitest.

`pnpm run acceptance` is now `node src/runAcceptance.ts`: the five scenarios in one process, in the
order `src/scenarios/index.ts` lists them, asserting with `node:assert/strict`, stopping at the first
failure. The suite used vitest as a shell while switching off almost everything vitest does, and paid
for the parts it could not switch off (a module graph per spec file, a reporter owning the console) in
a `globalSetup` hook, an RPC channel and a custom sequencer, all of which are gone: the run id and the
personal password are ordinary values, and the ask now fills the unlock holder rather than handing a
password back.

Nothing the scenarios assert changed. The pass prints its own report (each step as it starts, the
failure in full, then a summary naming which scenario broke and that the ones after it did not run),
records a `failure` line in the journal that `status` can read from another window, and exits 2 rather
than 1 when it refused to start at all. `acceptance:watch` is gone with the vitest config, and the
entry points target modern Node, so they no longer pass `--experimental-strip-types`.

Design record: `backend/docs/adr/0057-acceptance-standalone-runner.md`.

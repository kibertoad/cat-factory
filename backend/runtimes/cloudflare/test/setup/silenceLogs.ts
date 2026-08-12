import { beforeEach } from 'vitest'
import { setLogLevel } from '@cat-factory/server'

// Silence the app's own logger for the whole suite, the same way and for the same reasons as
// `@cat-factory/server`'s `test/setup/silenceLogs.ts` — read that file for the full argument and
// for how a test that wants to ASSERT on a log line does it instead (kernel's
// `createRecordingLogger()`, which never consults this gate).
//
// It matters more here than anywhere: these specs drive the real engine over a real local D1, so a
// green run emitted ~2900 application log lines, three quarters of the shard's whole transcript.
// Every one of them said something the assertions already said, and they buried the lines that did
// carry information — an unhandled-rejection block, a failed assertion — in the middle of a
// four-thousand-line scroll. `setLogLevel` is what the port documents for this; it accepts
// `silent`, which no `LOG_LEVEL` value parses to, so no deployment can reach this state.
//
// Applied before EVERY test, not once at load: the gate is module state, and establishing it is
// the first thing a real entry point does (`applyLogSettings`, which all eight call). Specs that
// drive one for real — `create-worker.test.ts` and `extension-surface.test.ts` reach
// `worker.fetch` — therefore raise the threshold back to `info` mid-suite, and the pool runs the
// files through one shared worker, so a single one-shot call at load would leave the silencing
// covering whatever happened to run before them. Re-establishing it per test makes that
// structural rather than a thing each such spec has to remember to undo (`log-gate.test.ts` pins
// it).
//
// A file that wants the gate RAISED (the three log-export tests, whose assertions read lines they
// emitted) still raises it in its own `beforeEach`: vitest runs setup-file hooks first, so the
// file's own hook wins for the duration of its tests. Those files also lower it again in
// `afterEach`, which is not redundant with this — no `beforeEach` covers a later file's
// `beforeAll`/`afterAll`.
setLogLevel('silent')
beforeEach(() => setLogLevel('silent'))

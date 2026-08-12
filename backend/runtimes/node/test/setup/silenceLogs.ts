import { beforeEach } from 'vitest'
import { setLogLevel } from '@cat-factory/server'

// Silence the app's own logger for the whole suite, the same way and for the same reasons as
// `@cat-factory/server`'s `test/setup/silenceLogs.ts` — read that file for the full argument and
// for how a test that wants to ASSERT on a log line does it instead (kernel's
// `createRecordingLogger()`, which never consults this gate).
//
// Symmetric with the Worker facade's copy, and needed for the same reason: these specs drive the
// real engine over real Postgres, and a green run emitted ~3600 application log lines.
//
// Per-test rather than once at load, for the reason the Worker's copy states at length: the gate
// is module state and `start()`'s first move is `setLogLevel(parseLogLevel(env.LOG_LEVEL))`, so
// any spec that boots the facade in-process leaves the rest of the run chatty. None does today,
// and re-establishing the gate per test is what keeps that from being a fact someone has to know.
setLogLevel('silent')
beforeEach(() => setLogLevel('silent'))

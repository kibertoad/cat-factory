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
setLogLevel('silent')

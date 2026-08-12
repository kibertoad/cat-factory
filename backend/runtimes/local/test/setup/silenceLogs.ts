import { beforeEach } from 'vitest'
import { setLogLevel } from '@cat-factory/server'

// Silence the app's own logger for the whole suite, the same way and for the same reasons as
// `@cat-factory/server`'s `test/setup/silenceLogs.ts` — read that file for the full argument and
// for how a test that wants to ASSERT on a log line does it instead (kernel's
// `createRecordingLogger()`, which never consults this gate).
//
// Symmetric with the Node and Worker facades' copies: the local facade runs the same engine and
// the same conformance groups, so it produces the same transcript noise, and `startLocal()`
// establishes its own threshold exactly as `start()` does.
setLogLevel('silent')
beforeEach(() => setLogLevel('silent'))

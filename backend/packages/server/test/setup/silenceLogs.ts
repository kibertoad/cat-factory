import { setLogLevel } from '../../src/observability/logger.js'

// Silence the process-wide logger for the whole suite.
//
// These tests drive real routes, so they run the real `mountRequestLogging` middleware and
// the real handlers, and those legitimately log: an SSO round-trip alone emits a line per
// sign-in, refusal and token rejection. On a GREEN run every one of those lines is noise —
// it says nothing the assertions do not — and it dominated the suite's output (~109KB of a
// ~198KB whole-repo run), which is pure cost for anything reading the transcript, a CI log
// reader or an agent alike.
//
// The module-level gate is the right seam precisely because `requestLogger(c)` falls back to
// the process-wide `logger` when a test mounts no middleware of its own: silencing here
// covers both paths at once, where passing `noopLogger` would have to be repeated at every
// call site and would be forgotten by the next one added.
//
// A test that wants to ASSERT on a log line does not fight this: it injects kernel's
// `createRecordingLogger()` and reads `.lines`, which never touches this gate.
setLogLevel('silent')

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { getLogLevel } from '@cat-factory/server'
import { applyLogSettings } from '../src/infrastructure/observability/logSettings'

// The suite-wide silencing (`test/setup/silenceLogs.ts`) has to survive the product doing exactly
// what it does in production. Every Worker entry point's first move is `applyLogSettings(env)`,
// which sets the threshold from `LOG_LEVEL` — and two specs here drive an entry point for real
// (`create-worker.test.ts` and `extension-surface.test.ts` call `worker.fetch`). The pool runs the
// whole suite through one shared worker, so before the setup file re-established the gate per test
// those calls left every later file emitting the application's own log lines again, silently and
// in an order only the shard's file distribution decided.
//
// Pinned on this facade alone because this is the one where an entry point runs in-process; the
// Node and local copies of the setup file are the same shape so their `start()`/`startLocal()`
// cannot become the exception the day a spec boots one.
describe('the suite-wide log gate', () => {
  it('is raised by an entry point establishing its own settings, as production does', () => {
    // No OTEL config in the test env, so this installs no sink: the threshold is the whole effect.
    applyLogSettings(env)
    expect(getLogLevel()).toBe('info')
  })

  it('is silent again for the next test, so one entry-point boot cannot un-silence the suite', () => {
    expect(getLogLevel()).toBe('silent')
  })
})

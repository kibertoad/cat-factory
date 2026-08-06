import { describe, expect, it } from 'vitest'
import type { LocalEventSink } from '@cat-factory/node-server'
import type { LogFields, Logger } from '@cat-factory/server'
import { authEnabledContainer, fanOutRealtime } from './authBackend.ts'

// The two pieces of the auth-enabled surface whose breakage is invisible in the browser suite:
// events silently reaching only one listener, and an auth config that is not actually auth-enabled.
// Both would surface as "the auth-stack spec hangs waiting for something", which is the flake shape
// this browser-free lane exists to pre-empt (see the e2e README).

/** A sink that records what it was handed, optionally throwing first. */
function recordingSink(opts: { throws?: boolean } = {}): LocalEventSink & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    broadcast(workspaceId, payload) {
      if (opts.throws) throw new Error('sink is down')
      seen.push(`${workspaceId}:${payload}`)
    },
  }
}

/**
 * A `Logger` that records instead of emitting: kernel's own `createRecordingLogger`, hand-rolled
 * here because this test-only package deliberately holds no direct `@cat-factory/kernel` dependency
 * (the same reason the fakes derive their port shapes structurally). It is also what keeps a green
 * run SILENT: the swallow path below is driven on purpose, twice.
 */
function recordingLogger(): Logger & { warnings: { msg: string; fields?: LogFields }[] } {
  const warnings: { msg: string; fields?: LogFields }[] = []
  const self: Logger & { warnings: typeof warnings } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warnings.push({ msg, ...(fields ? { fields } : {}) })
    },
    error: () => {},
    child: () => self,
  }
  return self
}

describe('fanOutRealtime', () => {
  it('delivers every event to both sinks, with the origin connection id', () => {
    const primary = recordingSink()
    const secondary = recordingSink()
    const seen: (string | null | undefined)[] = []
    const tee = fanOutRealtime(
      primary,
      {
        broadcast: (workspaceId, payload, origin) => {
          secondary.broadcast(workspaceId, payload, origin)
          seen.push(origin)
        },
      },
      recordingLogger(),
    )

    tee.broadcast('ws_1', 'first', 'cid_a')
    tee.broadcast('ws_2', 'second')

    expect(primary.seen).toEqual(['ws_1:first', 'ws_2:second'])
    expect(secondary.seen).toEqual(['ws_1:first', 'ws_2:second'])
    // The `?cid=` is what stops a board mutation echoing back to the connection that caused it, so
    // a fan-out that dropped it would reintroduce the optimistic-echo clobber on the second stack.
    expect(seen).toEqual(['cid_a', undefined])
  })

  it('still delivers to the other sink when one throws, and REPORTS the drop', () => {
    const healthy = recordingSink()
    const logger = recordingLogger()

    // Either position: the fan-out order must not decide whether an event is delivered.
    fanOutRealtime(recordingSink({ throws: true }), healthy, logger).broadcast(
      'ws_1',
      'from-second',
    )
    fanOutRealtime(healthy, recordingSink({ throws: true }), logger).broadcast('ws_1', 'from-first')

    expect(healthy.seen).toEqual(['ws_1:from-second', 'ws_1:from-first'])
    // A swallowed drop with nothing logged is the failure mode itself: the auth stack goes deaf and
    // the browser can only show a board that painted once. So the warn, its cause and the workspace
    // it was about are asserted, not just the delivery that survived.
    expect(logger.warnings).toHaveLength(2)
    for (const warning of logger.warnings) {
      expect(warning.msg).toContain('fan-out')
      expect(warning.fields).toMatchObject({ workspaceId: 'ws_1', error: 'sink is down' })
    }
  })
})

describe('authEnabledContainer', () => {
  it('turns auth on and both anonymous-admission flags off, keeping the config and the services', () => {
    const service = { marker: 'the one real service graph' }
    const base = {
      workspaceService: service,
      config: {
        auth: {
          enabled: false,
          passwordEnabled: false,
          testingNoAuth: true,
          devOpen: true,
          sessionTtlMs: 42,
        },
        somethingElse: 'kept',
      },
    }

    const authed = authEnabledContainer(base as never) as unknown as typeof base

    // `devOpen` off is the assertion with no visible consequence TODAY: every reader tests `enabled`
    // before reaching the short-circuit, so the surface is closed either way. It is asserted because
    // that ordering is the entire margin, and a reader that consulted `devOpen` first would open
    // every route on the stack whose specs exist to prove the front door is shut.
    expect(authed.config.auth).toEqual({
      enabled: true,
      passwordEnabled: true,
      testingNoAuth: false,
      devOpen: false,
      sessionTtlMs: 42,
    })
    expect(authed.config.somethingElse).toBe('kept')
    // The SAME services: one engine, one worker, one set of repositories behind both surfaces. A
    // clone that rebuilt anything here would give the auth stack its own disconnected world.
    expect(authed.workspaceService).toBe(service)
    // ...and the original is untouched, so the anonymous surface stays dev-open.
    expect(base.config.auth.testingNoAuth).toBe(true)
  })
})

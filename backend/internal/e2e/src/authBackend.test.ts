import { describe, expect, it } from 'vitest'
import type { LocalEventSink } from '@cat-factory/node-server'
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

describe('fanOutRealtime', () => {
  it('delivers every event to both sinks, with the origin connection id', () => {
    const primary = recordingSink()
    const secondary = recordingSink()
    const seen: (string | null | undefined)[] = []
    const tee = fanOutRealtime(primary, {
      broadcast: (workspaceId, payload, origin) => {
        secondary.broadcast(workspaceId, payload, origin)
        seen.push(origin)
      },
    })

    tee.broadcast('ws_1', 'first', 'cid_a')
    tee.broadcast('ws_2', 'second')

    expect(primary.seen).toEqual(['ws_1:first', 'ws_2:second'])
    expect(secondary.seen).toEqual(['ws_1:first', 'ws_2:second'])
    // The `?cid=` is what stops a board mutation echoing back to the connection that caused it, so
    // a fan-out that dropped it would reintroduce the optimistic-echo clobber on the second stack.
    expect(seen).toEqual(['cid_a', undefined])
  })

  it('still delivers to the other sink when one throws', () => {
    const healthy = recordingSink()

    // Either position: the fan-out order must not decide whether an event is delivered.
    fanOutRealtime(recordingSink({ throws: true }), healthy).broadcast('ws_1', 'from-second')
    fanOutRealtime(healthy, recordingSink({ throws: true })).broadcast('ws_1', 'from-first')

    expect(healthy.seen).toEqual(['ws_1:from-second', 'ws_1:from-first'])
  })
})

describe('authEnabledContainer', () => {
  it('turns auth on and testing-no-auth off, keeping the rest of the config and the services', () => {
    const service = { marker: 'the one real service graph' }
    const base = {
      workspaceService: service,
      config: {
        auth: { enabled: false, passwordEnabled: false, testingNoAuth: true, sessionTtlMs: 42 },
        somethingElse: 'kept',
      },
    }

    const authed = authEnabledContainer(base as never) as unknown as typeof base

    expect(authed.config.auth).toEqual({
      enabled: true,
      passwordEnabled: true,
      testingNoAuth: false,
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

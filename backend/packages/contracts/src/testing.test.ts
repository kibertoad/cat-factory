import { describe, expect, it } from 'vitest'
import { parseTesterInfraSetup } from './testing.js'

// The Tester's in-container stand-up record, which crosses the container→backend HTTP boundary and
// is therefore parsed defensively. What is pinned here is the field that carries a DIAGNOSIS rather
// than a measurement: `dockerAvailable` separates a compose stack that failed to come up from an
// executor that had no daemon to talk to, and those have opposite fixes. Its absence is a third
// state (an older image, or the native host transport, which runs the harness with no entrypoint to
// probe) and reading absence as `false` would report every older image as a broken executor.

const base = { started: false, at: 1_700_000_000_000 }

describe('parseTesterInfraSetup', () => {
  it('carries a decided absence of a Docker daemon', () => {
    expect(parseTesterInfraSetup({ ...base, dockerAvailable: false })).toMatchObject({
      started: false,
      dockerAvailable: false,
    })
  })

  it('leaves the diagnosis absent when the container reported none', () => {
    const parsed = parseTesterInfraSetup(base)
    expect(parsed).not.toBeNull()
    expect(parsed?.dockerAvailable).toBeUndefined()
  })

  it('accepts a record from an image that predates the field', () => {
    expect(
      parseTesterInfraSetup({
        started: true,
        composePath: 'docker-compose.yml',
        at: 1,
        durationMs: 12,
        logs: 'container db  Healthy',
      }),
    ).toMatchObject({ started: true, composePath: 'docker-compose.yml' })
  })

  it('answers null for a malformed record rather than a half-parsed one', () => {
    expect(parseTesterInfraSetup({ started: 'yes', at: 1 })).toBeNull()
    expect(parseTesterInfraSetup({ ...base, dockerAvailable: 'false' })).toBeNull()
    expect(parseTesterInfraSetup(undefined)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { parseTesterInfraSetup } from './testing.js'

// The Tester's in-container stand-up record, which crosses the container→backend HTTP boundary and
// is therefore parsed defensively. What is pinned here are the fields that carry a DIAGNOSIS rather
// than a measurement: `dockerAvailable` separates a compose stack that failed to come up from an
// executor that had no daemon to talk to, and `dockerWorkload` separates BOTH from a daemon that
// answers while being unable to run a container. Three fixes, in three different places: the
// service's compose file, the executor image or its sandbox, and a daemon that is already up.
// Every one of the two fields has an absent state (an older image, or the native host transport,
// which runs the harness with no entrypoint to probe), and reading absence as a decided negative
// would report every older image as a broken executor.

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

  it('carries a reachable daemon that cannot run a container as BOTH facts', () => {
    // The pair `dockerAvailable` alone cannot express, and the reason it gained a sibling: a
    // rootless daemon nested in a sandbox answers throughout while unable to mount any image
    // layer, so it is reachable and no stack can come up on it. Flattened onto `false` it renders
    // as "no Docker daemon in the executor" and sends a human to restart one that is already up.
    expect(
      parseTesterInfraSetup({ ...base, dockerAvailable: true, dockerWorkload: 'unusable' }),
    ).toMatchObject({ dockerAvailable: true, dockerWorkload: 'unusable' })
  })

  it('distinguishes a check that could not tell from one that was never taken', () => {
    expect(parseTesterInfraSetup({ ...base, dockerWorkload: 'undetermined' })?.dockerWorkload).toBe(
      'undetermined',
    )
    expect(parseTesterInfraSetup(base)?.dockerWorkload).toBeUndefined()
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
    // A closed vocabulary, so a word this build does not know is a malformed record rather than a
    // value the SPA would have to render as something.
    expect(parseTesterInfraSetup({ ...base, dockerWorkload: 'serving' })).toBeNull()
    expect(parseTesterInfraSetup(undefined)).toBeNull()
  })
})

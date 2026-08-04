import { describe, expect, it } from 'vitest'
import { isDryRun, resolveRunMode } from './runMode.logic.js'

// How a run's mode is settled at start: what the caller asked for, composed with the roles the
// task's merge preset sandboxes. The composition is one-way by design, and these lock that.

describe('resolveRunMode', () => {
  it('defaults to live', () => {
    expect(resolveRunMode({ requested: undefined, role: 'member', dryRunRoles: [] })).toEqual({
      mode: 'live',
      source: 'default',
    })
  })

  it('honours an explicit dry-run request', () => {
    expect(resolveRunMode({ requested: 'dry_run', role: 'admin', dryRunRoles: [] })).toEqual({
      mode: 'dry_run',
      source: 'requested',
    })
  })

  it('forces a sandboxed role into dry-run even when it asked for live', () => {
    // The point of the setting: the person starting the run is not the person deciding what may
    // land, so there is no way to ask out of it.
    expect(resolveRunMode({ requested: 'live', role: 'member', dryRunRoles: ['member'] })).toEqual({
      mode: 'dry_run',
      source: 'role_policy',
    })
  })

  it('reports a policy sandbox as `role_policy`, not as the request', () => {
    // A person who asked for a live run and got a sandbox has to be able to tell policy from a
    // mis-click; folding this into `requested` would leave "the product ignored me" as the only
    // available reading.
    const asked = resolveRunMode({
      requested: 'dry_run',
      role: 'member',
      dryRunRoles: ['member'],
    })
    expect(asked).toEqual({ mode: 'dry_run', source: 'role_policy' })
  })

  it('leaves a role the preset does not sandbox alone', () => {
    expect(
      resolveRunMode({ requested: undefined, role: 'admin', dryRunRoles: ['member'] }),
    ).toEqual({ mode: 'live', source: 'default' })
  })

  it('never force-sandboxes an unattributed run', () => {
    // A schedule fire / public-API start / auth-disabled dev has no role to match, and treating
    // absent as the lowest tier would sandbox every scheduled run in a deployment the day it
    // first sandboxes a role.
    for (const role of [null, undefined]) {
      expect(
        resolveRunMode({ requested: undefined, role, dryRunRoles: ['viewer', 'member', 'admin'] }),
      ).toEqual({ mode: 'live', source: 'default' })
    }
  })

  it('still honours an explicit request on an unattributed run', () => {
    expect(
      resolveRunMode({ requested: 'dry_run', role: null, dryRunRoles: ['member'] }),
    ).toMatchObject({ mode: 'dry_run' })
  })

  it('treats an absent dryRunRoles (a preset predating the field) as sandboxing nobody', () => {
    expect(
      resolveRunMode({ requested: undefined, role: 'member', dryRunRoles: undefined }),
    ).toEqual({ mode: 'live', source: 'default' })
  })
})

describe('isDryRun', () => {
  it('reads an absent mode as live, the way every legacy run must', () => {
    expect(isDryRun(undefined)).toBe(false)
    expect(isDryRun('live')).toBe(false)
    expect(isDryRun('dry_run')).toBe(true)
  })
})

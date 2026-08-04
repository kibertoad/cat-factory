import { describe, expect, it } from 'vitest'
import type { WorkspaceRole } from '@cat-factory/kernel'
import { isDryRun, resolveRunMode, settleRunModeForStart } from './runMode.logic.js'

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

describe('settleRunModeForStart', () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger }

  const settle = (
    over: Partial<Parameters<typeof settleRunModeForStart>[0]> & {
      loadDryRunRoles?: () => Promise<readonly WorkspaceRole[] | undefined>
    } = {},
  ) =>
    settleRunModeForStart({
      requested: undefined,
      role: 'member',
      loadDryRunRoles: async () => [],
      baseNotes: [],
      logger,
      fields: {},
      ...over,
    })

  it('joins the sandbox advisory onto the notes the run already carries', async () => {
    // A sandbox nobody ASKED for has to announce itself: from the board, a run that will never
    // merge looks exactly like one that has not got there yet.
    const { mode, notes } = await settle({
      role: 'member',
      loadDryRunRoles: async () => ['member'],
      baseNotes: ['a frontend note'],
    })
    expect(mode).toBe('dry_run')
    expect(notes[0]).toBe('a frontend note')
    expect(notes.at(-1)).toContain('Sandboxed run')
  })

  it('adds no advisory to a sandbox the initiator asked for', async () => {
    const { mode, notes } = await settle({ requested: 'dry_run', loadDryRunRoles: async () => [] })
    expect(mode).toBe('dry_run')
    expect(notes).toEqual([])
  })

  it('does not read the preset at all for an unattributed start', async () => {
    // Only a pinned role can match a `dryRunRoles` entry, so on a schedule fire / public-API
    // start / auth-disabled dev the answer cannot change the outcome. Reading it anyway is a
    // preset resolution per scheduled run bought for nothing.
    let reads = 0
    const { mode } = await settle({
      role: null,
      loadDryRunRoles: async () => {
        reads += 1
        return ['viewer', 'member', 'admin']
      },
    })
    expect(reads).toBe(0)
    expect(mode).toBe('live')
  })

  it('reads the preset exactly once for an attributed start', async () => {
    let reads = 0
    await settle({
      role: 'admin',
      loadDryRunRoles: async () => {
        reads += 1
        return []
      },
    })
    expect(reads).toBe(1)
  })
})

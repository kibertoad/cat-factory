import { UNATTRIBUTED_BLOCK_EDITOR } from '@cat-factory/contracts'
import type { WorkspacePermission, WorkspaceRole } from '@cat-factory/kernel'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/http/env.js'
import { blockEditAuthority } from '../src/http/workspaceAccess.js'

// ---------------------------------------------------------------------------
// WHOSE authority a board write is made under, in WHICH workspace.
//
// The coverage spec beside this one pins that every deciding site names an authority; this pins
// what the authority answers. The distinction matters because a board mounts services homed in
// other workspaces, and a write on one lands at that home: the row is written there, its preset
// resolves against that library, and a run on it is admitted through that board under the role
// the editor holds THERE. A single tier read off the acting board answers for the home only by
// coincidence, and the two ways it is wrong are opposite: an admin of the acting board skipping
// a check on a home where they are a plain member, and a member of the acting board refused on
// roles they hold nowhere the decision applies.
// ---------------------------------------------------------------------------

const ACTING = 'ws_acting'
const OTHER = 'ws_other'

/**
 * A context carrying what the auth gate publishes, plus a container whose access resolution is the
 * pass-through the Worker's isolate-safe cache profile also is. `reads` records every workspace
 * the resolver actually went to the repository for, which is how the memoisation is asserted.
 */
function contextFor(options: {
  actingRole: WorkspaceRole
  actingPermissions?: WorkspacePermission[]
  elsewhere?: Record<string, { role: WorkspaceRole; permissions?: WorkspacePermission[] }>
}) {
  const reads: string[] = []
  const grants = options.elsewhere ?? {}
  // Stubbed at the cache seam, which is where `loadWorkspaceAccess` reads through: the rules
  // themselves are `resolveWorkspaceAccess`'s and are covered where they live. What this spec is
  // about is WHICH workspace gets asked, so the roster is a map and every lookup is recorded.
  const values: Record<string, unknown> = {
    workspaceAccess: {
      workspaceId: ACTING,
      role: options.actingRole,
      permissions: new Set(options.actingPermissions ?? []),
    },
    user: { id: 'user_1' },
    container: {
      caches: {
        workspaceAccess: {
          get: async (_key: string, workspaceId: string) => {
            reads.push(workspaceId)
            const grant = grants[workspaceId]
            return {
              access: grant
                ? { allowed: true, role: grant.role, permissions: new Set(grant.permissions ?? []) }
                : null,
            }
          },
        },
      },
    },
  }
  const c = { get: (key: string) => values[key] } as unknown as Context<AppEnv>
  return { c, reads }
}

describe('blockEditAuthority', () => {
  it('answers the acting board off the gate, with no repository read', async () => {
    // The gate already resolved it on this very request (ADR 0025 keeps membership resolution in
    // one place), so re-reading it would be both wasted and a second answer to one question.
    const { c, reads } = contextFor({ actingRole: 'admin', actingPermissions: ['settings.manage'] })
    expect(await blockEditAuthority(c).in(ACTING)).toEqual({ role: 'admin', managesPolicy: true })
    expect(reads).toEqual([])
  })

  it('resolves ANOTHER workspace on its own roster, not the acting board’s', async () => {
    // The escape one board removed: an admin here who is a plain member of the home a write
    // actually lands in must be judged as that member. Reading the acting tier instead lets them
    // skip a guard on a workspace that granted them nothing.
    const { c } = contextFor({
      actingRole: 'admin',
      actingPermissions: ['settings.manage'],
      elsewhere: { [OTHER]: { role: 'member' } },
    })
    expect(await blockEditAuthority(c).in(OTHER)).toEqual({ role: 'member', managesPolicy: false })
  })

  it('reads a workspace once however many times it is asked about', async () => {
    // A moved subtree asks per side, and a mixed board write can ask again; each is the same
    // question about the same request, so it is answered once.
    const { c, reads } = contextFor({
      actingRole: 'member',
      elsewhere: { [OTHER]: { role: 'admin', permissions: ['settings.manage'] } },
    })
    const authority = blockEditAuthority(c)
    const [first, second] = await Promise.all([authority.in(OTHER), authority.in(OTHER)])
    expect(first).toEqual({ role: 'admin', managesPolicy: true })
    expect(second).toEqual(first)
    expect(reads).toEqual([OTHER])
  })

  it('reports no tier for a workspace the editor cannot see', async () => {
    // Not a denial to report: with no membership there they can admit no run under that
    // workspace's policies, so none of its restrictions is theirs to hold or to drop. Reading
    // this as "unrestricted" would refuse a move into a service they are not a member of, naming
    // a sandbox nobody would have escaped.
    const { c } = contextFor({ actingRole: 'admin', actingPermissions: ['settings.manage'] })
    expect(await blockEditAuthority(c).in(OTHER)).toEqual(UNATTRIBUTED_BLOCK_EDITOR)
  })

  it('reports no tier anywhere when auth is disabled', async () => {
    // Dev-open resolves no access object and no user, the same reading a run started there gets
    // when it pins no `initiatedByRole`: there is no tier, rather than an invented one.
    const values = { user: null } as Record<string, unknown>
    const c = { get: (key: string) => values[key] } as unknown as Context<AppEnv>
    const authority = blockEditAuthority(c)
    expect(await authority.in(ACTING)).toEqual(UNATTRIBUTED_BLOCK_EDITOR)
    expect(await authority.in(OTHER)).toEqual(UNATTRIBUTED_BLOCK_EDITOR)
  })
})

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCode } from './coverageScan.js'

// ---------------------------------------------------------------------------
// Every HTTP route that WRITES a block has to decide whose authority the write is made under,
// for the same reason a run start has to decide whose tier it is admitted under (see
// `runAdmission.coverage.spec.ts`, whose shape this mirrors). A task's `riskPolicyId` selects the
// merge policy that decides whether ITS runs are sandboxed for a role and how their auto-merge is
// narrowed (ADR 0037), so re-pointing a task (or authoring one straight onto a permissive preset)
// is a policy decision. Passing the editor is what gets it judged.
//
// The typecheck already forces every caller to pass SOMETHING (`BlockEditActor` is a required
// parameter, deliberately). What it cannot force is the right something: `UNATTRIBUTED_BLOCK_EDITOR`
// compiles everywhere and silently exempts the route, which is exactly how the role-scoped merge
// policy first shipped: enforced on one controller while another module's route escaped it.
//
// So this CLASSIFIES each call site. A new board-writing route fails here until someone writes
// down which bucket it is in, which is the moment to think about it.
// ---------------------------------------------------------------------------

const ROOTS: Record<string, string> = { server: join(import.meta.dirname, '..', 'src') }

/**
 * Routes that write a block ON BEHALF OF A SIGNED-IN PERSON acting on their own board. Each must
 * pass the editor from `blockEditActor`, never a hand-rolled read of the gate's context: one
 * authority for membership (ADR 0025), one shape to audit.
 */
const ATTRIBUTED = ['server:modules/board/BoardController.ts']

/**
 * Routes that deliberately pass the UNATTRIBUTED editor, with the reason. These are not
 * oversights: an editor with no workspace tier holds no role-scoped restriction that a preset
 * selection could drop, so judging one would mean inventing an authority nobody granted.
 */
const UNATTRIBUTED: Record<string, string> = {
  'server:modules/publicApi/PublicApiController.ts':
    'a headless `/api/v1` caller authenticates as an API KEY, which holds scopes rather than a ' +
    'workspace tier, so there is no role for a merge preset to sandbox or narrow, and the task ' +
    'patch contract exposes title/description only, so no preset can be selected here in any case.',
}

describe('block-write routes classify their editor', () => {
  const code = loadCode(ROOTS)
  const writers = [...code.entries()]
    .filter(([, source]) => /boardService\.(updateBlock|addTask)\(/.test(source))
    .map(([key]) => key)

  it('finds the board-write routes at all (the scan itself must not silently match nothing)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(2)
  })

  it('classifies every board-write route as attributed or deliberately unattributed', () => {
    const unclassified = writers.filter(
      (key) => !ATTRIBUTED.includes(key) && !(key in UNATTRIBUTED),
    )
    expect(unclassified).toEqual([])
  })

  it('makes every attributed route read the editor through the one accessor', () => {
    for (const key of ATTRIBUTED) {
      const source = code.get(key)!
      expect(writers, `${key} no longer writes a block`).toContain(key)
      expect(source, `${key} must pass the editor via blockEditActor`).toContain(
        'blockEditActor(c)',
      )
      // A hand-rolled read is the drift this guards: it compiles, it works, and it is a second
      // place to get the dev-open absent-access fallback wrong.
      expect(source, `${key} must not re-derive the access object`).not.toContain(
        "c.get('workspaceAccess')",
      )
      // An attributed route that ALSO reaches for the unattributed constant would be exempting
      // one of its own writes without saying so.
      expect(source, `${key} must not exempt a write`).not.toContain('UNATTRIBUTED_BLOCK_EDITOR')
    }
  })

  it('keeps a stated reason beside every unattributed route', () => {
    for (const [key, reason] of Object.entries(UNATTRIBUTED)) {
      expect(writers, `${key} no longer writes a block`).toContain(key)
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40)
    }
  })
})

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCode } from './coverageScan.js'

// ---------------------------------------------------------------------------
// Every board write has to decide whose authority it is made under, for the same reason a run
// start has to decide whose tier it is admitted under (see `runAdmission.coverage.spec.ts`, whose
// shape this mirrors). A task's `riskPolicyId` selects the merge policy that decides whether ITS
// runs are sandboxed for a role and how their auto-merge is narrowed (ADR 0037), so re-pointing a
// task, or authoring one straight onto a permissive preset, is a policy decision. Passing the
// editor is what gets it judged.
//
// The typecheck already forces every board-write entry point to be HANDED an actor
// (`BlockEditActor` is a required parameter, deliberately). What it cannot force is the right one:
// `UNATTRIBUTED_BLOCK_EDITOR` compiles everywhere and silently exempts the write, which is exactly
// how the role-scoped merge policy first shipped: enforced on one controller while another
// module's route escaped it.
//
// So this classifies the sites that DECIDE, and only those. A module that merely declares an
// `editor: BlockEditActor` parameter and passes it along has decided nothing and needs no entry;
// it inherited its answer, and the typecheck already guarantees it cannot invent one. What must be
// written down is every site that NAMES a value: `blockEditActor(c)` (the acting tier, read
// through the one accessor) or `UNATTRIBUTED_BLOCK_EDITOR` (no tier at all, with the reason).
//
// That inversion is the point. Keying on the CALL (`boardService.addTask(` and friends) is what
// the first cut of this spec did, and it saw neither `addServiceTask` (the public-API creation
// path, a fifth spelling) nor the writes made through `TaskLinkService` / `DocumentLinkService`,
// which are in a different package entirely. Each was hardcoding its own exemption where no route
// stated it and no spec could see it. Naming the ACTOR is the one thing every such site has to do,
// whatever it calls and wherever it lives, which is why the scan spans the three packages that can
// hold one.
// ---------------------------------------------------------------------------

const packageSrc = (name: string) => join(import.meta.dirname, '..', '..', name, 'src')

const ROOTS: Record<string, string> = {
  server: join(import.meta.dirname, '..', 'src'),
  orchestration: packageSrc('orchestration'),
  integrations: packageSrc('integrations'),
}

/** Where `blockEditActor` is DEFINED, which is not a site that decides anything with it. */
const ACCESSOR_DEFINITION = 'server:http/workspaceAccess.ts'

/**
 * Sites that write a block ON BEHALF OF A SIGNED-IN PERSON acting on their own board. Each must
 * take the tier from `blockEditActor`, never a hand-rolled read of the gate's context: one
 * authority for membership (ADR 0025), one shape to audit.
 *
 * All four are HTTP routes, and that is not a coincidence: the acting tier is a fact about the
 * REQUEST, so the only layer that can answer honestly is the one holding a request.
 */
const ATTRIBUTED = [
  'server:modules/board/BoardController.ts',
  'server:modules/tasks/TaskSourceController.ts',
  'server:modules/documents/DocumentSourceController.ts',
  'server:modules/bugHunt/BugHuntController.ts',
]

/**
 * Sites that deliberately name the UNATTRIBUTED editor, with the reason. These are not oversights:
 * an editor with no workspace tier holds no role-scoped restriction that a preset selection could
 * drop, so judging one would mean inventing an authority nobody granted.
 *
 * Two shapes qualify and nothing else does. A route whose caller authenticated as something that
 * is not a member (an API key holds scopes, not a tier), and an ENGINE path with no request behind
 * it at all: a cron sweep, a webhook delivery, a blueprint reconciliation. A member-tier route
 * belongs in `ATTRIBUTED` however deep below it the write happens.
 */
const UNATTRIBUTED: Record<string, string> = {
  'server:modules/publicApi/PublicApiController.ts':
    'a headless `/api/v1` caller authenticates as an API KEY, which holds scopes rather than a ' +
    'workspace tier, so there is no role for a merge preset to sandbox or narrow, and the task ' +
    'patch contract exposes title/description only, so no preset can be selected here in any case.',
  'server:modules/publicApi/taskCreation.ts':
    'the `/api/v1` task CREATION route, on the same API-key reading as the patch route above. ' +
    'Stated at the route rather than inside `addServiceTask`, because that method takes a full ' +
    '`AddTaskInput` and would carry a preset the day the public contract exposes one.',
  'orchestration:container/modules.ts':
    'the tracker intake path: a ticket arriving on a schedule or a webhook delivery is filed by ' +
    'nobody, so there is no session and no tier, and inventing one would scope an entire ' +
    'integration to a role no operator granted.',
  'orchestration:modules/boardScan/BoardScanService.ts':
    'blueprint reconciliation runs in the engine with no request behind it: it materialises what ' +
    'a scan found rather than what a person chose, so there is no acting tier to read.',
}

describe('board-write sites classify their editor', () => {
  const code = loadCode(ROOTS)
  /** Every site that NAMES an actor value, which is every site that makes the decision. */
  const deciders = [...code.entries()]
    .filter(([key]) => key !== ACCESSOR_DEFINITION)
    .filter(([, source]) => /blockEditActor\(|UNATTRIBUTED_BLOCK_EDITOR/.test(source))
    .map(([key]) => key)

  it('finds the deciding sites at all (the scan itself must not silently match nothing)', () => {
    // A rename of either value would otherwise turn every assertion below vacuous, and a root
    // that resolved to the wrong directory would take its whole package's sites with it.
    expect(deciders.length).toBeGreaterThanOrEqual(ATTRIBUTED.length)
    expect(code.has(ACCESSOR_DEFINITION)).toBe(true)
    expect(code.has('orchestration:modules/board/BoardService.ts')).toBe(true)
    expect(code.has('integrations:modules/tasks/TaskLinkService.ts')).toBe(true)
  })

  it('classifies every deciding site as attributed or deliberately unattributed', () => {
    const unclassified = deciders.filter(
      (key) => !ATTRIBUTED.includes(key) && !(key in UNATTRIBUTED),
    )
    expect(unclassified).toEqual([])
  })

  it('keeps both lists honest: no stale entry, and none in both', () => {
    // A classified site that stopped deciding is a comment claiming a rule nothing enforces.
    for (const key of [...ATTRIBUTED, ...Object.keys(UNATTRIBUTED)]) {
      expect(deciders, `${key} no longer names an editor`).toContain(key)
    }
    expect(ATTRIBUTED.filter((key) => key in UNATTRIBUTED)).toEqual([])
  })

  it('makes every attributed site read the editor through the one accessor', () => {
    for (const key of ATTRIBUTED) {
      const source = code.get(key)!
      expect(source, `${key} must pass the editor via blockEditActor`).toContain(
        'blockEditActor(c)',
      )
      // A hand-rolled read is the drift this guards: it compiles, it works, and it is a second
      // place to get the dev-open absent-access fallback wrong.
      expect(source, `${key} must not re-derive the access object`).not.toContain(
        "c.get('workspaceAccess')",
      )
      // An attributed site that ALSO reaches for the unattributed constant would be exempting
      // one of its own writes without saying so.
      expect(source, `${key} must not exempt a write`).not.toContain('UNATTRIBUTED_BLOCK_EDITOR')
    }
  })

  it('keeps a stated reason beside every unattributed site, and no tier read', () => {
    for (const [key, reason] of Object.entries(UNATTRIBUTED)) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40)
      // The converse of the check above: a site claiming no tier must not also read one.
      expect(code.get(key), `${key} claims no tier, so it must not read one`).not.toContain(
        'blockEditActor(c)',
      )
    }
  })
})

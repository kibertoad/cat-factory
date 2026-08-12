import { join } from 'node:path'
import {
  addTaskSchema,
  createPublicTaskSchema,
  updateBlockSchema,
  updatePublicTaskSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
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
// The typecheck already forces every board-write entry point to be HANDED an authority
// (`BlockEditAuthority` is a required parameter, deliberately). What it cannot force is the right
// one: `UNATTRIBUTED_BLOCK_EDIT_AUTHORITY` compiles everywhere and silently exempts the write,
// which is exactly how the role-scoped merge policy first shipped: enforced on one controller
// while another module's route escaped it.
//
// So this classifies the sites that DECIDE, and only those. A module that merely declares an
// `editor: BlockEditActor` parameter and passes it along has decided nothing and needs no entry;
// it inherited its answer, and the typecheck already guarantees it cannot invent one. What must be
// written down is every site that NAMES a value: `blockEditAuthority(c)` (the editor's authority,
// resolvable in whichever workspace the write decides in, read through the one accessor) or
// `UNATTRIBUTED_BLOCK_EDIT_AUTHORITY` (no tier anywhere, with the reason).
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

/** Where `blockEditAuthority` is DEFINED, which is not a site that decides anything with it. */
const ACCESSOR_DEFINITION = 'server:http/workspaceAccess.ts'

/**
 * Sites that write a block ON BEHALF OF A SIGNED-IN PERSON acting on their own board. Each must
 * take the authority from `blockEditAuthority`, never a hand-rolled read of the gate's context:
 * one authority for membership (ADR 0025), one shape to audit. It is a RESOLVER rather than a
 * resolved tier because a write on a mounted foreign service decides in that service's home, and
 * the acting board's role answers for that workspace only by coincidence.
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
    'the `/api/v1` task PATCH route. A headless caller authenticates as an API KEY, which holds ' +
    'scopes rather than a workspace tier, so there is no role for a risk policy to sandbox or ' +
    'narrow and nothing for the selection guard to judge. The route CAN re-point `riskPolicyId`, ' +
    'so this is a real exemption and not a vacuous one: which policies a key may pin is the ' +
    'admission rule tracked in `docs/initiatives/role-scoped-risk-policy-admission.md`.',
  'server:modules/publicApi/PublicProvisioningController.ts':
    'the `/api/v1` service PATCH route, on the same API-key reading as the task routes below: a ' +
    'key holds scopes rather than a workspace tier, so no role-scoped restriction exists for a ' +
    'policy selection to drop. A SERVICE frame carries no `riskPolicyId` of its own either, and ' +
    '`toBlockPatch` lowers the body key by key rather than spreading it, so none reaches ' +
    '`updateBlock` even if the public service schema gains one.',
  'server:modules/publicApi/taskCreation.ts':
    'the `/api/v1` task CREATION route, on the same API-key reading as the patch route above. ' +
    'Stated at the route rather than inside `addServiceTask`, because that method takes a full ' +
    '`AddTaskInput` and is reached by callers that DO have a tier.',
  'orchestration:container/modules.ts':
    'the tracker intake path: a ticket arriving on a schedule or a webhook delivery is filed by ' +
    'nobody, so there is no session and no tier, and inventing one would scope an entire ' +
    'integration to a role no operator granted.',
  'orchestration:modules/boardScan/BoardScanService.ts':
    'blueprint reconciliation runs in the engine with no request behind it: it materialises what ' +
    'a scan found rather than what a person chose, so there is no acting tier to read.',
  'orchestration:modules/execution/PostMergeBoardController.ts':
    'the post-merge follow-up that materialises the module a merged task named and moves the ' +
    'task into it: the engine acting on what the run produced, with no session behind it. The ' +
    'move is also within the one service, so it changes no merge-preset resolution either way.',
}

describe('board-write sites classify their editor', () => {
  const code = loadCode(ROOTS)
  /** Every site that NAMES an actor value, which is every site that makes the decision. */
  const deciders = [...code.entries()]
    .filter(([key]) => key !== ACCESSOR_DEFINITION)
    .filter(([, source]) => /blockEditAuthority\(|UNATTRIBUTED_BLOCK_EDIT_AUTHORITY/.test(source))
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
      expect(source, `${key} must pass the editor via blockEditAuthority`).toContain(
        'blockEditAuthority(c)',
      )
      // A hand-rolled read is the drift this guards: it compiles, it works, and it is a second
      // place to get the dev-open absent-access fallback wrong.
      expect(source, `${key} must not re-derive the access object`).not.toContain(
        "c.get('workspaceAccess')",
      )
      // An attributed site that ALSO reaches for the unattributed constant would be exempting
      // one of its own writes without saying so.
      expect(source, `${key} must not exempt a write`).not.toContain(
        'UNATTRIBUTED_BLOCK_EDIT_AUTHORITY',
      )
    }
  })

  it('keeps a stated reason beside every unattributed site, and no tier read', () => {
    for (const [key, reason] of Object.entries(UNATTRIBUTED)) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40)
      // The converse of the check above: a site claiming no tier must not also read one.
      expect(code.get(key), `${key} claims no tier, so it must not read one`).not.toContain(
        'blockEditAuthority(c)',
      )
    }
  })
})

/**
 * The second half of the three `/api/v1` exemptions above, which their reasons LEAN ON.
 *
 * Until surface 1.43.0 the claim they leaned on was that the public contract exposed no preset at
 * all, so nothing could be selected through a key in the first place. That is no longer true: both
 * public task schemas now carry `modelPresetId` and `riskPolicyId`, deliberately (see the schema's
 * own doc for why withholding one was never the control it resembled). What replaces the old
 * assertion is the property that makes the exemptions HONEST rather than lucky.
 *
 * Two things are pinned, and they fail differently.
 *
 * The public field NAMES the internal one, character for character. Both routes lower the parsed
 * body by SPREAD (`const { ticket, documents, fields, ...rest } = body`, and `...authored` on the
 * patch), so the pins reach `AddTaskInput` / `UpdateBlockInput` only because the two vocabularies
 * agree. Rename either side alone and the spread silently stops carrying the value: no type error,
 * no failing route test, just every headless task quietly running on the workspace default. That
 * is precisely the "succeeds while being about something else" failure the field exists to
 * prevent, arriving through the plumbing instead of through a typo.
 *
 * And the surface admits NO OTHER internal knob by the same route. The spread is total, so any
 * field the public schema declares and `AddTaskInput` happens to share is lowered whether anyone
 * decided that or not; the pins are the two that were decided.
 */
describe('the /api/v1 task surface lowers its preset pins by name', () => {
  /**
   * Read off the INTERNAL schemas rather than written down here, so this spec cannot go vacuous by
   * outliving either field: rename one internally and these reads fail, which is the failure that
   * points at the rename.
   */
  const PINS = ['modelPresetId', 'riskPolicyId'] as const

  it('still describes real internal fields (the writes it guards both carry them)', () => {
    for (const pin of PINS) {
      expect(Object.keys(addTaskSchema.entries)).toContain(pin)
      expect(Object.keys(updateBlockSchema.entries)).toContain(pin)
    }
  })

  it('declares each pin on both public schemas, under the internal spelling', () => {
    for (const pin of PINS) {
      expect(Object.keys(createPublicTaskSchema.entries)).toContain(pin)
      expect(Object.keys(updatePublicTaskSchema.entries)).toContain(pin)
    }
  })

  it('carries a supplied pin THROUGH the parse, so the spread onto the internal input lands it', () => {
    const created = v.parse(createPublicTaskSchema, {
      title: 'Ship it',
      modelPresetId: 'mdp_claude',
      riskPolicyId: 'mp_open',
    })
    expect(created).toMatchObject({ modelPresetId: 'mdp_claude', riskPolicyId: 'mp_open' })
    const patched = v.parse(updatePublicTaskSchema, {
      title: 'Renamed',
      modelPresetId: 'mdp_claude',
      riskPolicyId: 'mp_open',
    })
    expect(patched).toMatchObject({ modelPresetId: 'mdp_claude', riskPolicyId: 'mp_open' })
  })

  it('admits no OTHER internal write field through the same spread', () => {
    // Whatever the two schemas share is lowered by the spread, so the overlap IS the decision.
    // Derived from the schemas themselves rather than listed, so a public field added tomorrow
    // that happens to collide with an internal knob (`agentConfig`, `epicId`, …) fails here
    // instead of shipping as an undeclared capability.
    const overlap = (publicKeys: string[], internalKeys: string[]) =>
      publicKeys.filter((key) => internalKeys.includes(key)).sort()
    const create = overlap(
      Object.keys(createPublicTaskSchema.entries),
      Object.keys(addTaskSchema.entries),
    )
    const update = overlap(
      Object.keys(updatePublicTaskSchema.entries),
      Object.keys(updateBlockSchema.entries),
    )
    // `title`/`description` (+ `taskType` at creation, `autoStartDependents` on the patch) are the
    // authored input both surfaces have always shared; the two pins are what 1.43.0 added. Nothing
    // else may join them without a decision made here.
    //
    // `pipelineId` at CREATION is the decision 1.50.0 made, and it is deliberately create-only: a
    // caller files a task and lets somebody start it later, from the board or from an empty start
    // body, and still gets the chain the filer chose. It is NOT on the patch, because re-pointing a
    // task's pipeline after the fact is a board judgement about work already described, and the
    // start call already takes a `pipelineId` for the one run a caller wants to redirect.
    expect(create).toEqual([
      'description',
      'modelPresetId',
      'pipelineId',
      'riskPolicyId',
      'taskType',
      'title',
    ])
    expect(update).toEqual([
      'autoStartDependents',
      'description',
      'modelPresetId',
      'riskPolicyId',
      'title',
    ])
  })
})

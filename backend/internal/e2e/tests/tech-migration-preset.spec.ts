import { MIGRATION_PHASE_IDS, TECH_MIGRATION_PRESET_ID } from '@cat-factory/agents'
import { expect, test } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  approveStep,
  createInitiative,
  findParkedApproval,
  setFakeProfile,
  startRun,
} from './helpers'

// The assembled-product proof of the tech-migration PRESET flow (tech-migration slice T10) — the
// SECOND real initiative preset, and the one that exercises the pieces the docs-refresh S9 baseline
// (`initiative-preset.spec.ts`) does NOT: a FULL-interview preset (`interview: 'full'` binding
// `pl_initiative`, so the run has an interviewer step + a human planner gate), a five-phase
// template-shaped plan (the generic ingest normalizer enforces `MIGRATION_PHASE_IDS`), and the
// `seedMigrationPlan` spawn decoration that turns the phase-1 blast-zone report into a DOCUMENT
// task. Extends the S9 baseline rather than forking: same `FakeProfile.initiativePlan` planner seam,
// same live-board-only assertions. See `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`.
//
// Two extra fakes beyond the baseline make the full-interview pipeline run deterministically end to
// end on the keyless e2e backend:
//   - the interviewer runs an INLINE LLM (not the faked agent executor); `testServer.ts` injects a
//     converging fake inline model (`fakeInlineModel.ts`), so the interviewer converges on its first
//     pass over the seeded intake-form qa and the run advances to the analyst — no human Q&A needed.
//   - the `initiative-planner` gate (`gate: true` in `pl_initiative`) parks the run for human
//     approval, but no SPA surface exposes that gate for an initiative-level block, so it is
//     approved over REST (a trigger) — see `findParkedApproval` / `approveStep`.

// The plan the fake `initiative-planner` returns. It MUST carry the five migration template phase
// ids in order (imported, never retyped — they are the contract the ingest normalizer matches on);
// a missing/extra phase would fault the planning run at ingest. One item per phase; `seedMigrationPlan`
// then decorates phase 1 (blast-zone) + phase 3 (transition-design) as documents, injects the phase-2
// confidence-case document, and leaves the coverage/delivery/verify items as coding.
const MIGRATION_PLAN = {
  goal: 'Migrate the billing service from MSSQL to PostgreSQL, preserving observable behaviour.',
  analysisSummary:
    'Stored procedures back the settlement path; reporting queries are collation-sensitive.',
  phases: [
    { id: MIGRATION_PHASE_IDS.blastZone, title: 'Blast zone' },
    { id: MIGRATION_PHASE_IDS.coverage, title: 'Coverage hardening' },
    { id: MIGRATION_PHASE_IDS.transitionDesign, title: 'Compatibility & transition design' },
    { id: MIGRATION_PHASE_IDS.delivery, title: 'Delivery' },
    { id: MIGRATION_PHASE_IDS.verifyDecommission, title: 'Verify & decommission' },
  ],
  items: [
    {
      id: 'itm_blast',
      phaseId: MIGRATION_PHASE_IDS.blastZone,
      title: 'Inventory the MSSQL touchpoints',
      description: 'Enumerate every stored proc, trigger, view and query site the swap touches.',
    },
    {
      id: 'itm_cov',
      phaseId: MIGRATION_PHASE_IDS.coverage,
      title: 'Characterize the settlement path',
      description: 'Pin the settlement behaviour with tests above the DB seam.',
      dependsOn: ['itm_blast'],
    },
    {
      id: 'itm_design',
      phaseId: MIGRATION_PHASE_IDS.transitionDesign,
      title: 'Design the cutover',
      description: 'Decide the compatibility posture and the migration path.',
    },
    {
      id: 'itm_deliver',
      phaseId: MIGRATION_PHASE_IDS.delivery,
      title: 'Replace the settlement procedures',
      description: 'Execute the swap per the approved design.',
    },
    {
      id: 'itm_verify',
      phaseId: MIGRATION_PHASE_IDS.verifyDecommission,
      title: 'Verify parity and decommission MSSQL',
      description: 'Prove parity on PostgreSQL, flip defaults, remove the old path.',
    },
  ],
  policy: { maxConcurrent: 2, defaultPipelineId: 'pl_quick', rules: [] },
}

test('a tech-migration initiative interviews, plans a 5-phase migration, and spawns a decorated blast-zone document', async ({
  page,
  request,
  seededBoard,
}) => {
  // Drives a full planning run (interviewer → analyst → planner → gate → committer) then a loop
  // spawn — several durable pg-boss steps — so give it the slow budget.
  test.slow()
  const { workspaceId } = seededBoard

  // Disable the default one-shot agent decision gate (so the analyst/planner steps don't park on a
  // fake decision), and feed the planner the five-phase migration plan above. Set BEFORE the run.
  await setFakeProfile(request, workspaceId, {
    decisionOnSteps: [],
    initiativePlan: MIGRATION_PLAN,
  })

  // Create the initiative from the built-in tech-migration preset. Its required form fields are
  // supplied here (the create validator rejects a missing required visible field); the create flow
  // seeds the interview qa from them so the interviewer builds on the form rather than re-asking it.
  // The anchor card arrives on the board live via `initiative-added`.
  const { block } = await createInitiative(
    request,
    workspaceId,
    'blk_auth',
    TECH_MIGRATION_PRESET_ID,
    {
      migrationKind: 'database',
      fromTech: 'MSSQL 2019 + stored procedures',
      toTech: 'PostgreSQL 16',
      migrationDocsDir: 'docs/migration',
      coverageBar: 'strict',
      humanReview: true,
    },
  )
  await expect(page.getByTestId('initiative-card')).toBeVisible({ timeout: LIVE_TIMEOUT })

  // Start the preset's full-interview planning pipeline against the anchor block. The interviewer
  // converges on the seeded qa (fake inline model) → analyst → planner returns MIGRATION_PLAN → the
  // ingest normalizer accepts the five template phases → the run PARKS at the planner's human gate.
  await startRun(request, workspaceId, block.id, 'pl_initiative')

  // Approve the parked planner gate over REST (no SPA affordance exposes it for an initiative
  // block). Poll for the parked approval — a green ingest of the 5-phase plan is a precondition for
  // it existing, so reaching here already proves the template normalization accepted the plan.
  let approval: Awaited<ReturnType<typeof findParkedApproval>> = null
  await expect
    .poll(
      async () => {
        approval = await findParkedApproval(request, workspaceId, block.id, 'initiative-planner')
        return approval !== null
      },
      { timeout: RUN_TERMINAL_TIMEOUT },
    )
    .toBe(true)
  await approveStep(request, workspaceId, approval!)

  // After approval the committer flips the initiative to `executing`; the fast loop sweep spawns the
  // first wave — phase 1's blast-zone report, which `seedMigrationPlan` decorated as a DOCUMENT task.
  // It lands on the board live (`block-added`); the seed has no document tasks, so this locator is
  // unique to the spawned, decorated migration artifact.
  await expect(page.locator('[data-testid="task-card"][data-task-type="document"]')).toBeVisible({
    timeout: RUN_TERMINAL_TIMEOUT,
  })
})

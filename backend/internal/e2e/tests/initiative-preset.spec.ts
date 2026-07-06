import { expect, test } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createInitiative,
  setFakeProfile,
  startRun,
} from './helpers'

// The assembled-product proof of the initiative-PRESET flow: create-with-preset → auto-plan →
// the loop spawning a first-class TYPED (decorated) task, asserted only on live, WebSocket-pushed
// board updates. This is the S9 baseline the tech-migration preset's E2E (T10) extends rather than
// forking. See `docs/initiatives/initiative-presets-and-docs-refresh.md` (slice 9) and
// `backend/docs/initiative-presets.md`.
//
// The pilot preset (`preset_docs_refresh`) is `interview: 'skip'` and binds `pl_initiative_docs`
// (analyst → planner → committer, NO interviewer, NO human gate), so the whole planning run is
// unattended: the fake planner returns the plan below, the committer flips the initiative to
// `executing`, and the periodic loop sweep spawns the first item. At ingest the preset's phase
// template + `seedPlan` DECORATE the readme item — routing it to `pl_document_quick` and stamping
// `taskType: 'document'` — so the spawned block is a DOCUMENT task, the decoration this spec proves.

// The plan the fake `initiative-planner` returns. It must satisfy the docs-refresh phase template
// (Foundations `required`, per-doc-type phases OPTIONAL, `allowAdditionalPhases: false`), so it
// carries the (item-less) `foundations` phase plus one `readme` item — the ingest normalizer would
// otherwise reject a missing required phase / an unknown extra and fault the run.
const DOCS_PLAN = {
  goal: 'Bring the Auth Service documentation current.',
  analysisSummary: 'The Auth Service README is stale; no other docs exist.',
  phases: [
    { id: 'foundations', title: 'Foundations' },
    { id: 'readme', title: 'README refresh' },
  ],
  items: [
    {
      id: 'itm_readme_auth',
      phaseId: 'readme',
      title: 'Refresh the Auth Service README',
      description: 'Rewrite the Auth Service README to match the current implementation.',
    },
  ],
  policy: { maxConcurrent: 2, defaultPipelineId: 'pl_document_quick', rules: [] },
}

test('creating a docs-refresh initiative auto-plans and spawns a decorated document task', async ({
  page,
  request,
  seededBoard,
}) => {
  const { workspaceId } = seededBoard

  // Disable the default one-shot decision gate (so the analyst step doesn't park), and feed the
  // planner the plan above. Skip-interview preset + gate-less planning pipeline ⇒ nothing else to
  // drive: the run advances analyst → planner → committer on its own. Set BEFORE the run starts.
  await setFakeProfile(request, workspaceId, { decisionOnSteps: [], initiativePlan: DOCS_PLAN })

  // Create the initiative from the built-in docs-refresh preset. Its anchor card arrives on the
  // board live via `initiative-added` (a fresh workspace has exactly one initiative card).
  const { block } = await createInitiative(
    request,
    workspaceId,
    'blk_auth',
    'preset_docs_refresh',
    {
      docTypes: ['readme'],
    },
  )
  await expect(page.getByTestId('initiative-card')).toBeVisible({ timeout: LIVE_TIMEOUT })

  // Start the preset's planning pipeline against the anchor block (planning has no dedicated
  // route — it's the ordinary execution endpoint). analyst → planner (returns the plan) →
  // committer flips the initiative to `executing`; the fast loop sweep then spawns the first item.
  await startRun(request, workspaceId, block.id, 'pl_initiative_docs')

  // spawn-with-decoration: the loop spawns the readme item as a first-class DOCUMENT task (the
  // preset's `seedPlan` stamped `taskType: 'document'`), which lands on the board live. The seed
  // has no document tasks, so this locator is unique to the spawned, decorated task.
  await expect(page.locator('[data-testid="task-card"][data-task-type="document"]')).toBeVisible({
    timeout: RUN_TERMINAL_TIMEOUT,
  })
})

// ---------------------------------------------------------------------------
// Acceptance test scenarios.
//
// A freeform, black-box acceptance scenario in Given / When / Then form, attached
// to a single task (block). These are what the `acceptance` agent drafts from a
// block's requirements (its description + linked PRDs), and what the `playwright`
// agent turns into end-to-end tests. The board is server-owned, but — like the
// agent palette — scenarios are an editable, client-side prototype surface,
// persisted locally so a user can author and refine the set for a task before
// wiring up real runs. (A deeper requirements-driven model is planned; for now the
// set is simply scoped to the task.)
// ---------------------------------------------------------------------------

/** Where a scenario came from: drafted by the acceptance agent or hand-written. */
export type ScenarioSource = 'generated' | 'manual'

/** Review state of a scenario in its task's current set. */
export type ScenarioStatus = 'draft' | 'approved'

/** A single acceptance scenario for a task. */
export interface AcceptanceScenario {
  id: string
  /** The task (`Block.id`) this scenario verifies. */
  blockId: string
  /** Short, human title — also the name of the generated Playwright test. */
  title: string
  /** Preconditions (one clause per entry). */
  given: string[]
  /** The user action under test (kept to a single clear action). */
  when: string[]
  /** Observable, asserted outcomes. */
  then: string[]
  status: ScenarioStatus
  source: ScenarioSource
  /** True once a Playwright test has been generated for this scenario. */
  hasPlaywrightTest: boolean
  createdAt: number
}

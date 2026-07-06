import type { InitiativePlanDraft, InitiativePresetInputs } from '@cat-factory/contracts'
import { parseInitiativePlanDraft } from '@cat-factory/contracts'
import { DOCUMENT_QUICK_PIPELINE_ID, seedPipelines } from '@cat-factory/kernel'
import { MIGRATION_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'
import { MIGRATION_PHASE_IDS } from './phases.js'
import {
  DEFAULT_MIGRATION_DOCS_DIR,
  FIELD_HUMAN_REVIEW,
  FIELD_MIGRATION_DOCS_DIR,
  migrationReviewGates,
  seedMigrationPlan,
} from './seed-plan.js'

// T7 lands `seedMigrationPlan` UNWIRED (T8 registers the preset), so these pin its OWN contract as a
// pure post-processor: per-phase spawn decoration, the confidence-case injection/gating/dependsOn,
// the coverage granularity cap, and the humanReview gate policy. The generic phase-template shaping
// + ingest re-parse are exercised by the InitiativeService/conformance suites; here we assert the
// hook's output directly and re-parse it (the ingest trust boundary) so any unsafe path would throw.

const P = MIGRATION_PHASE_IDS

/** A template-shaped draft with items across all five migration phases (as the planner would emit). */
function draftFixture(): InitiativePlanDraft {
  return parseInitiativePlanDraft({
    goal: 'Migrate MSSQL to PostgreSQL',
    phases: [
      { id: P.blastZone, title: 'Blast zone' },
      { id: P.coverage, title: 'Coverage hardening' },
      { id: P.transitionDesign, title: 'Compatibility & transition design' },
      { id: P.delivery, title: 'Delivery' },
      { id: P.verifyDecommission, title: 'Verify & decommission' },
    ],
    items: [
      { id: 'bz1', phaseId: P.blastZone, title: 'Enumerate the blast zone' },
      { id: 'cov1', phaseId: P.coverage, title: 'Characterize the orders API' },
      { id: 'cov2', phaseId: P.coverage, title: 'Characterize the billing job' },
      { id: 'td1', phaseId: P.transitionDesign, title: 'Design the cutover' },
      { id: 'del1', phaseId: P.delivery, title: 'Swap the orders repository' },
      { id: 'ver1', phaseId: P.verifyDecommission, title: 'Verify parity and remove MSSQL' },
    ],
    policy: { maxConcurrent: 2, defaultPipelineId: 'pl_quick' },
  })
}

/** Run the hook + re-parse (the ingest trust boundary) so an unsafe spawn path would throw. */
function seed(inputs: InitiativePresetInputs, draft = draftFixture()): InitiativePlanDraft {
  return parseInitiativePlanDraft(seedMigrationPlan(draft, inputs))
}

const byId = (draft: InitiativePlanDraft) => new Map(draft.items.map((i) => [i.id, i]))
const confidenceOf = (draft: InitiativePlanDraft) =>
  draft.items.find(
    (i) =>
      i.phaseId === P.coverage &&
      i.spawn?.taskTypeFields?.targetPath?.endsWith('confidence-case.md'),
  )

describe('seedMigrationPlan — document artifacts', () => {
  it('stamps the blast-zone report as a document under the docs dir', () => {
    const bz = byId(seed({})).get('bz1')
    expect(bz?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(bz?.spawn?.taskType).toBe('document')
    expect(bz?.spawn?.taskTypeFields?.docKind).toBe('technical')
    expect(bz?.spawn?.taskTypeFields?.targetPath).toBe('docs/migration/blast-zone.md')
  })

  it('stamps the transition design as a document, always human-gated', () => {
    // humanReview OFF — the design gate is intrinsic (the compat-posture control point), so it stays.
    const td = byId(seed({ [FIELD_HUMAN_REVIEW]: false })).get('td1')
    expect(td?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(td?.spawn?.taskType).toBe('document')
    expect(td?.spawn?.taskTypeFields?.docKind).toBe('design')
    expect(td?.spawn?.taskTypeFields?.targetPath).toBe('docs/migration/transition-design.md')
    expect(td?.spawn?.gates).toEqual(migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID))
  })

  it('honours a custom migrationDocsDir', () => {
    const bz = byId(seed({ [FIELD_MIGRATION_DOCS_DIR]: 'migration' })).get('bz1')
    expect(bz?.spawn?.taskTypeFields?.targetPath).toBe('migration/blast-zone.md')
  })

  it('gives a second same-phase document a distinct derived path (single writer per file)', () => {
    const draft = draftFixture()
    draft.items.push({
      id: 'td2',
      phaseId: P.transitionDesign,
      title: 'Design the data migration',
      description: '',
      dependsOn: [],
    })
    const items = byId(seed({}, draft))
    expect(items.get('td1')?.spawn?.taskTypeFields?.targetPath).toBe(
      'docs/migration/transition-design.md',
    )
    expect(items.get('td2')?.spawn?.taskTypeFields?.targetPath).toBe(
      'docs/migration/design-the-data-migration.md',
    )
  })
})

describe('seedMigrationPlan — coding items', () => {
  it('leaves coverage / delivery / verify items as coding (no forced pipeline or taskType)', () => {
    const items = byId(seed({}))
    for (const id of ['cov1', 'cov2', 'del1', 'ver1']) {
      expect(items.get(id)?.pipelineId).toBeUndefined()
      expect(items.get(id)?.spawn?.taskType).toBeUndefined()
      expect(items.get(id)?.spawn?.gates).toBeUndefined()
    }
  })
})

describe('seedMigrationPlan — migration fragments', () => {
  it('stamps the migration fragments on EVERY spawned item', () => {
    for (const item of seed({}).items) {
      expect(item.spawn?.fragmentIds).toEqual([...MIGRATION_FRAGMENT_IDS])
    }
  })
})

describe('seedMigrationPlan — the confidence case', () => {
  it('injects a human-gated confidence-case document that dependsOn every coverage item', () => {
    const draft = seed({})
    const cc = confidenceOf(draft)
    expect(cc).toBeDefined()
    expect(cc?.spawn?.taskType).toBe('document')
    expect(cc?.spawn?.taskTypeFields?.targetPath).toBe('docs/migration/confidence-case.md')
    expect(cc?.spawn?.gates).toEqual(migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID))
    expect(new Set(cc?.dependsOn)).toEqual(new Set(['cov1', 'cov2']))
    // It closes phase 2 — the last item of the plan in document order.
    expect(draft.items[draft.items.length - 1]).toBe(cc)
  })

  it('is human-gated even when humanReview is off (it is an intrinsic control point)', () => {
    const cc = confidenceOf(seed({ [FIELD_HUMAN_REVIEW]: false }))
    expect(cc?.spawn?.gates).toEqual(migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID))
  })

  it('canonicalizes a planner-authored confidence case instead of duplicating it', () => {
    const draft = draftFixture()
    draft.items.push({
      id: 'cc-planner',
      phaseId: P.coverage,
      title: 'Author the confidence case',
      description: 'planner wrote this',
      dependsOn: ['cov1'],
    })
    const out = seed({}, draft)
    const confidences = out.items.filter(
      (i) =>
        i.phaseId === P.coverage &&
        i.spawn?.taskTypeFields?.targetPath?.endsWith('confidence-case.md'),
    )
    expect(confidences).toHaveLength(1)
    // The planner's item is reused (its description survives) and hardened with the deps + gate.
    expect(confidences[0]?.id).toBe('cc-planner')
    expect(confidences[0]?.description).toBe('planner wrote this')
    expect(new Set(confidences[0]?.dependsOn)).toEqual(new Set(['cov1', 'cov2']))
  })
})

describe('seedMigrationPlan — humanReview policy on informational docs', () => {
  it('gates the blast-zone report when humanReview is on (the default)', () => {
    expect(byId(seed({})).get('bz1')?.spawn?.gates).toEqual(
      migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID),
    )
  })

  it('leaves the blast-zone report ungated when humanReview is off', () => {
    expect(byId(seed({ [FIELD_HUMAN_REVIEW]: false })).get('bz1')?.spawn?.gates).toBeUndefined()
  })
})

describe('seedMigrationPlan — coverage granularity cap', () => {
  it('keeps at most eight coverage items and scrubs dependencies on the dropped ones', () => {
    const draft = draftFixture()
    // Ten coverage items (cov1..cov2 already present + eight more), and a delivery item that depends
    // on one that will be capped away — its dangling dep must be scrubbed.
    for (let n = 3; n <= 10; n++) {
      draft.items.push({
        id: `cov${n}`,
        phaseId: P.coverage,
        title: `Characterize area ${n}`,
        description: '',
        dependsOn: [],
      })
    }
    const del = draft.items.find((i) => i.id === 'del1')!
    del.dependsOn = ['cov10'] // cov10 is the 10th coverage item → dropped by the cap
    const out = seedMigrationPlan(draft, {})
    const coverage = out.items.filter(
      (i) =>
        i.phaseId === P.coverage &&
        !i.spawn?.taskTypeFields?.targetPath?.endsWith('confidence-case.md'),
    )
    expect(coverage).toHaveLength(8)
    expect(out.items.find((i) => i.id === 'cov9')).toBeUndefined()
    expect(out.items.find((i) => i.id === 'cov10')).toBeUndefined()
    // The dangling dep on the capped-away cov10 is scrubbed.
    expect(out.items.find((i) => i.id === 'del1')?.dependsOn).toEqual([])
    // The confidence case depends on the eight SURVIVING coverage items, never a dropped one.
    const cc = confidenceOf(parseInitiativePlanDraft(out))
    expect(cc?.dependsOn).not.toContain('cov10')
    expect(cc?.dependsOn).toHaveLength(8)
  })
})

describe('seedMigrationPlan — invariants', () => {
  it('never touches the plan phases (shape is the template’s job)', () => {
    const before = draftFixture().phases
    expect(seedMigrationPlan(draftFixture(), {}).phases).toEqual(before)
  })

  it('produces a draft that re-parses (spawn paths stay repo-safe)', () => {
    expect(() => seed({ [FIELD_MIGRATION_DOCS_DIR]: DEFAULT_MIGRATION_DOCS_DIR })).not.toThrow()
  })

  it('migrationReviewGates puts a single gate on the pipeline’s merge step', () => {
    const kinds = seedPipelines().find((p) => p.id === DOCUMENT_QUICK_PIPELINE_ID)?.agentKinds ?? []
    const gates = migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID)
    expect(gates?.length).toBe(kinds.length)
    expect(gates?.filter(Boolean)).toHaveLength(1)
    expect(gates?.[kinds.lastIndexOf('merger')]).toBe(true)
  })
})

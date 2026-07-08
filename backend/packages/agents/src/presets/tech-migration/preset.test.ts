import {
  parseInitiativePlanDraft,
  parseInitiativePresetDescriptor,
  validateInitiativePresetInputs,
} from '@cat-factory/contracts'
import {
  DOCUMENT_QUICK_PIPELINE_ID,
  INITIATIVE_PIPELINE_ID,
  InitiativePresetRegistry,
} from '@cat-factory/kernel'
import { MIGRATION_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'
import { MIGRATION_PHASE_ID_ORDER, MIGRATION_PHASE_IDS } from './phases.js'
import { MIGRATION_PROMPT_ADDITIONS } from './prompt-additions.js'
import { seedMigrationPlan } from './seed-plan.js'
import {
  TECH_MIGRATION_PRESET,
  TECH_MIGRATION_PRESET_ID,
  registerTechMigrationPreset,
} from './preset.js'

// The preset is preloaded by `defaultInitiativePresetRegistry()`; `registerTechMigrationPreset(registry)`
// installs it on an app-owned registry. These tests pin the PRESET's own wiring contract — a valid
// descriptor, the five-phase template matching the canonical ids, the conservative policy defaults,
// the interview + review posture, and that it composes the already-tested T4/T5/T7 pieces.
// `seedMigrationPlan` and the phase-template ingest machinery have their own suites; here we assert
// the descriptor is well-formed and the hooks are wired to the right pieces.

const preset = TECH_MIGRATION_PRESET

describe('preset_tech_migration — descriptor + registration', () => {
  it('is a valid preset with NO probe (no detect hook), registered on an app-owned registry', () => {
    expect(() => parseInitiativePresetDescriptor(preset.descriptor)).not.toThrow()
    const registry = new InitiativePresetRegistry()
    registerTechMigrationPreset(registry)
    expect(registry.get(TECH_MIGRATION_PRESET_ID)).toBe(preset)
    expect(preset.detect).toBeUndefined()
    const descriptor = registry.descriptors().find((d) => d.id === TECH_MIGRATION_PRESET_ID)
    // `probe` is derived from `detect`; there is none, so the SPA never fires a probe for it.
    expect(descriptor?.probe).toBe(false)
  })

  it('binds the interviewer-driven planning pipeline and is human-in-the-loop by default', () => {
    expect(preset.descriptor.planningPipelineId).toBe(INITIATIVE_PIPELINE_ID)
    expect(preset.descriptor.interview).toBe('full')
    expect(preset.descriptor.humanReviewDefault).toBe(true)
  })

  it('defaults its fragments to the full migration fragment set (T4)', () => {
    expect(preset.descriptor.defaultFragmentIds).toEqual([...MIGRATION_FRAGMENT_IDS])
  })

  it('declares the conservative migration execution policy', () => {
    expect(preset.descriptor.policyDefaults).toEqual({
      maxConcurrent: 2,
      defaultPipelineId: 'pl_quick',
      rules: [{ pipelineId: 'pl_full', minRisk: 0.6, minComplexity: 0.6 }],
      onMissingEstimate: 'strongest',
    })
  })

  it('wires the T5 methodology prompt additions and the T7 plan post-processor', () => {
    expect(preset.promptAdditions).toBe(MIGRATION_PROMPT_ADDITIONS)
    expect(preset.seedPlan).toBe(seedMigrationPlan)
  })

  it('an empty registry does not resolve the tech-migration preset until registered', () => {
    const registry = new InitiativePresetRegistry()
    expect(registry.get(TECH_MIGRATION_PRESET_ID)).toBeUndefined()
    registerTechMigrationPreset(registry)
    expect(registry.get(TECH_MIGRATION_PRESET_ID)).toBe(preset)
  })
})

describe('preset_tech_migration — phase template (plan SHAPE)', () => {
  it('declares the five canonical migration phases, all required, in methodology order', () => {
    const template = preset.descriptor.phaseTemplate
    expect(template).toBeDefined()
    expect(template!.allowAdditionalPhases).toBe(false)
    // The ids are the canonical phases from `phases.ts`, in the methodology order (verbatim), and
    // every one is required — the ingest normalizer rejects a plan missing any of them.
    expect(template!.phases.map((p) => p.id)).toEqual([...MIGRATION_PHASE_ID_ORDER])
    for (const phase of template!.phases) {
      expect(phase.required).toBe(true)
      expect(phase.goal?.trim()).toBeTruthy()
    }
  })

  it('does not retype any phase id (they come from the canonical constant)', () => {
    const ids = new Set(preset.descriptor.phaseTemplate!.phases.map((p) => p.id))
    expect(ids).toEqual(new Set(Object.values(MIGRATION_PHASE_IDS)))
  })
})

describe('preset_tech_migration — form', () => {
  it('requires the which/from/to/docs-dir/coverage-bar fields', () => {
    const required = new Set(preset.descriptor.fields.filter((f) => f.required).map((f) => f.key))
    expect(required).toEqual(
      new Set(['migrationKind', 'fromTech', 'toTech', 'migrationDocsDir', 'coverageBar']),
    )
  })

  it('shows the stored-procedure policy only for a database migration', () => {
    const field = preset.descriptor.fields.find((f) => f.key === 'storedProcPolicy')
    expect(field?.showWhen).toEqual({ key: 'migrationKind', equals: 'database' })
  })

  it('defaults human review ON (a migration stays human-in-the-loop)', () => {
    const field = preset.descriptor.fields.find((f) => f.key === 'humanReview')
    expect(field?.type).toBe('checkbox')
    // A `checkbox` default of the string 'true' is what the SPA seeds as a checked box.
    expect(field?.default).toBe('true')
  })

  it('accepts the pilot form values as a valid, complete submission', () => {
    const problems = validateInitiativePresetInputs(preset.descriptor, {
      migrationKind: 'database',
      fromTech: 'MSSQL (stored procedures, SQL Agent jobs)',
      toTech: 'PostgreSQL 16',
      storedProcPolicy: 'replace-with-app-code',
      coverageBar: 'strict',
      humanReview: true,
      migrationDocsDir: 'docs/migration',
    })
    expect(problems).toEqual([])
  })

  it('flags a submission missing the required fields', () => {
    const problems = validateInitiativePresetInputs(preset.descriptor, {})
    // migrationKind, fromTech, toTech, migrationDocsDir, coverageBar are all required.
    expect(problems.length).toBeGreaterThanOrEqual(5)
  })
})

describe('preset_tech_migration — seedPlan wiring (spawn decoration through the preset)', () => {
  // A smoke test that the preset's seedPlan is the migration post-processor: a template-shaped draft
  // comes out with the migration document decoration. The exhaustive behaviour lives in seed-plan.test.ts.
  it('decorates a template-shaped plan with the migration artifacts', () => {
    const draft = parseInitiativePlanDraft({
      goal: 'Migrate MSSQL to PostgreSQL',
      phases: MIGRATION_PHASE_ID_ORDER.map((id) => ({ id, title: id })),
      items: [
        { id: 'bz1', phaseId: MIGRATION_PHASE_IDS.blastZone, title: 'Enumerate the blast zone' },
        { id: 'cov1', phaseId: MIGRATION_PHASE_IDS.coverage, title: 'Characterize the orders API' },
        { id: 'td1', phaseId: MIGRATION_PHASE_IDS.transitionDesign, title: 'Design the cutover' },
        { id: 'del1', phaseId: MIGRATION_PHASE_IDS.delivery, title: 'Swap the orders repository' },
        { id: 'ver1', phaseId: MIGRATION_PHASE_IDS.verifyDecommission, title: 'Verify parity' },
      ],
      policy: { maxConcurrent: 2, defaultPipelineId: 'pl_quick' },
    })
    const out = parseInitiativePlanDraft(
      preset.seedPlan!(draft, { migrationDocsDir: 'docs/migration' }),
    )
    const bz = out.items.find((i) => i.id === 'bz1')
    expect(bz?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(bz?.spawn?.taskTypeFields?.targetPath).toBe('docs/migration/blast-zone.md')
    // A confidence case is injected to close phase 2.
    const cc = out.items.find((i) =>
      i.spawn?.taskTypeFields?.targetPath?.endsWith('confidence-case.md'),
    )
    expect(cc).toBeDefined()
    expect(cc?.dependsOn).toContain('cov1')
  })
})

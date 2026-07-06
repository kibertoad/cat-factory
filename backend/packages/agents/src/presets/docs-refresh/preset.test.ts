import type { InitiativePlanDraft, InitiativePresetInputs } from '@cat-factory/contracts'
import { parseInitiativePlanDraft, parseInitiativePresetDescriptor } from '@cat-factory/contracts'
import {
  BUSINESS_DOCS_PIPELINE_ID,
  CODE_COMMENTS_PIPELINE_ID,
  DOCUMENT_QUICK_PIPELINE_ID,
  INITIATIVE_DOCS_PIPELINE_ID,
  clearRegisteredInitiativePresets,
  getInitiativePreset,
  initiativePresetDescriptors,
  seedPipelines,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocsRepoReader } from './docs-detect.logic.js'
import {
  DOCS_REFRESH_PRESET,
  DOCS_REFRESH_PRESET_ID,
  docsReviewGates,
  registerDocsRefreshPreset,
} from './preset.js'

// The preset self-registers on import (the module side effect), so it is present without setup.
// The phaseTemplate + template-shaped ingest normalization are generic machinery already covered by
// the conformance suite; these tests pin the PRESET's own contract: a valid descriptor, the probe
// mapping, and — the crux of slice 8 — `seedPlan` as spawn DECORATION only (never plan shape).

const preset = DOCS_REFRESH_PRESET

describe('preset_docs_refresh — descriptor + registration', () => {
  it('is a valid, self-registered preset with a probe', () => {
    expect(() => parseInitiativePresetDescriptor(preset.descriptor)).not.toThrow()
    expect(getInitiativePreset(DOCS_REFRESH_PRESET_ID)).toBe(preset)
    const descriptor = initiativePresetDescriptors().find((d) => d.id === DOCS_REFRESH_PRESET_ID)
    // `probe` is derived from the wired `detect` hook when descriptors are serialised for the SPA.
    expect(descriptor?.probe).toBe(true)
  })

  it('binds the interviewer-free planning pipeline and is unattended by default', () => {
    expect(preset.descriptor.planningPipelineId).toBe(INITIATIVE_DOCS_PIPELINE_ID)
    expect(preset.descriptor.interview).toBe('skip')
    expect(preset.descriptor.humanReviewDefault).toBe(false)
  })

  it('declares a phase template with a required Foundations + optional per-type phases', () => {
    const template = preset.descriptor.phaseTemplate
    expect(template).toBeDefined()
    expect(template!.allowAdditionalPhases).toBe(false)
    const byId = new Map(template!.phases.map((p) => [p.id, p]))
    expect(byId.get('foundations')?.required).toBe(true)
    // Every per-doc-type phase is OPTIONAL, so the planner emits only the checked ones.
    for (const id of ['readme', 'diagrams', 'comments', 'business-rules']) {
      expect(byId.has(id)).toBe(true)
      expect(byId.get(id)?.required).not.toBe(true)
    }
  })

  it('re-registration is idempotent after a clear (the generic preset always survives)', () => {
    clearRegisteredInitiativePresets()
    expect(getInitiativePreset(DOCS_REFRESH_PRESET_ID)).toBeUndefined()
    registerDocsRefreshPreset()
    expect(getInitiativePreset(DOCS_REFRESH_PRESET_ID)).toBe(preset)
  })

  // The module side-effect ran at import; restore it for any downstream test in this file/run.
  afterEach(() => registerDocsRefreshPreset())
})

describe('preset_docs_refresh — detect (probe mapping)', () => {
  // A minimal RepoFiles-shaped reader; detect only reads getFile/listDirectory (a full RepoFiles is
  // not needed for the probe, so we cast the narrow reader).
  function reader(files: Record<string, string>): DocsRepoReader {
    const paths = Object.keys(files)
    return {
      async getFile(path) {
        return path in files ? { content: files[path]! } : null
      },
      async listDirectory(path) {
        const prefix = path ? `${path}/` : ''
        const children = new Map<string, 'file' | 'dir'>()
        for (const full of paths) {
          if (!full.startsWith(prefix)) continue
          const rest = full.slice(prefix.length)
          if (!rest) continue
          const slash = rest.indexOf('/')
          children.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'dir')
        }
        return [...children].map(([name, type]) => ({ name, type, path: prefix + name }))
      },
    }
  }

  it('maps the detected layout onto the placement form fields', async () => {
    const inputs = await preset.detect!(
      reader({
        'docs/architecture/overview.md': '# arch',
        'docs/domain/rules.md': '# rules',
      }) as never,
    )
    expect(inputs.placementMode).toBe('root')
    expect(inputs.docsRoot).toBe('docs')
    expect(inputs.diagramsDir).toBe('docs/architecture')
    expect(inputs.businessRulesDir).toBe('docs/domain')
  })
})

// ---------------------------------------------------------------------------
// seedPlan — the heart of slice 8: per-item spawn DECORATION only.
// ---------------------------------------------------------------------------

/** A template-shaped draft with one item per phase (as the steered planner would emit). */
function draftFixture(): InitiativePlanDraft {
  return parseInitiativePlanDraft({
    goal: 'Refresh the documentation',
    phases: [
      { id: 'foundations', title: 'Foundations' },
      { id: 'readme', title: 'README refresh' },
      { id: 'diagrams', title: 'Architecture & flow diagrams' },
      { id: 'comments', title: 'In-source comments' },
      { id: 'business-rules', title: 'Business rules' },
    ],
    items: [
      { id: 'f1', phaseId: 'foundations', title: 'Create docs index' },
      {
        id: 'r1',
        phaseId: 'readme',
        title: 'Auth service README',
        // A README is writer-placed (its per-service path lives in the description). Any OTHER
        // planner-authored spawn field (here an agentConfig) must survive seedPlan's decoration.
        spawn: { agentConfig: { 'playwright.e2eTarget': 'ci' } },
      },
      { id: 'd1', phaseId: 'diagrams', title: 'Billing architecture' },
      { id: 'c1', phaseId: 'comments', title: 'Comment the scheduler module' },
      { id: 'b1', phaseId: 'business-rules', title: 'Pricing rules' },
    ],
    policy: { maxConcurrent: 2, defaultPipelineId: 'pl_quick' },
  })
}

/** Run seedPlan and re-parse (the ingest trust boundary) so any unsafe spawn path would throw. */
function seed(inputs: InitiativePresetInputs): InitiativePlanDraft {
  const out = preset.seedPlan!(draftFixture(), inputs)
  return parseInitiativePlanDraft(out)
}

const FULL_INPUTS = {
  docTypes: ['readme', 'diagrams', 'comments', 'business-rules'],
  docsRoot: 'docs',
  diagramsDir: 'docs/diagrams',
  businessRulesDir: 'docs/business-logic',
  styleFragments: ['style.anti-llmisms', 'style.concise-actionable'],
}

describe('preset_docs_refresh — seedPlan (spawn decoration)', () => {
  it('routes each phase to its documentation pipeline', () => {
    const items = new Map(seed(FULL_INPUTS).items.map((i) => [i.id, i]))
    expect(items.get('f1')?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(items.get('r1')?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(items.get('d1')?.pipelineId).toBe(DOCUMENT_QUICK_PIPELINE_ID)
    expect(items.get('c1')?.pipelineId).toBe(CODE_COMMENTS_PIPELINE_ID)
    expect(items.get('b1')?.pipelineId).toBe(BUSINESS_DOCS_PIPELINE_ID)
  })

  it('derives placement paths and types per doc kind', () => {
    const items = new Map(seed(FULL_INPUTS).items.map((i) => [i.id, i]))
    // Foundations → a doc under the docs root.
    expect(items.get('f1')?.spawn?.taskType).toBe('document')
    expect(items.get('f1')?.spawn?.taskTypeFields?.targetPath).toBe('docs/create-docs-index.md')
    // Diagrams → a doc under the diagrams dir, docKind `other` (no `diagrams` DocKind).
    expect(items.get('d1')?.spawn?.taskTypeFields?.docKind).toBe('other')
    expect(items.get('d1')?.spawn?.taskTypeFields?.targetPath).toBe(
      'docs/diagrams/billing-architecture.md',
    )
    // README → a document task, docKind `reference`, but NO derived target path (writer-placed
    // beside the code from the description); the planner-authored agentConfig is preserved.
    expect(items.get('r1')?.spawn?.taskType).toBe('document')
    expect(items.get('r1')?.spawn?.taskTypeFields?.docKind).toBe('reference')
    expect(items.get('r1')?.spawn?.taskTypeFields?.targetPath).toBeUndefined()
    expect(items.get('r1')?.spawn?.agentConfig).toEqual({ 'playwright.e2eTarget': 'ci' })
    // Comments → code edit, NOT a document task, and no `.md` target path.
    expect(items.get('c1')?.spawn?.taskType).toBeUndefined()
    expect(items.get('c1')?.spawn?.taskTypeFields).toBeUndefined()
    // Business rules → a document task, but no single target (multi-doc under a dir).
    expect(items.get('b1')?.spawn?.taskType).toBe('document')
    expect(items.get('b1')?.spawn?.taskTypeFields?.targetPath).toBeUndefined()
  })

  it('stamps the chosen writing-style fragments on every decorated item', () => {
    for (const item of seed(FULL_INPUTS).items) {
      expect(item.spawn?.fragmentIds).toEqual(['style.anti-llmisms', 'style.concise-actionable'])
    }
  })

  it('adds NO gate override when human review is off (the default)', () => {
    for (const item of seed(FULL_INPUTS).items) {
      expect(item.spawn?.gates).toBeUndefined()
    }
  })

  it('gates the merge step of each pipeline when human review is on', () => {
    const items = new Map(seed({ ...FULL_INPUTS, humanReview: true }).items.map((i) => [i.id, i]))
    // Every doc pipeline is gated at its `merger` (review the CI-green PR before it merges).
    // pl_document_quick: [doc-writer, doc-reviewer, doc-quality, conflicts, ci, merger] — index 5.
    expect(items.get('d1')?.spawn?.gates).toEqual([false, false, false, false, false, true])
    // Lean author→conflicts→ci→merger pipelines: merger at index 3.
    expect(items.get('c1')?.spawn?.gates).toEqual([false, false, false, true])
    expect(items.get('b1')?.spawn?.gates).toEqual([false, false, false, true])
  })

  it('gives two same-title items distinct derived target paths (no file collision)', () => {
    const draft = draftFixture()
    // Two diagram items whose titles slug identically must not both stamp the same `.md` path.
    draft.items.push(
      {
        id: 'd2',
        phaseId: 'diagrams',
        title: 'Billing architecture',
        description: '',
        dependsOn: [],
      },
      {
        id: 'd3',
        phaseId: 'diagrams',
        title: 'Billing Architecture!',
        description: '',
        dependsOn: [],
      },
    )
    const items = new Map(
      parseInitiativePlanDraft(preset.seedPlan!(draft, FULL_INPUTS)).items.map((i) => [i.id, i]),
    )
    const paths = ['d1', 'd2', 'd3'].map((id) => items.get(id)?.spawn?.taskTypeFields?.targetPath)
    expect(new Set(paths).size).toBe(3)
    expect(paths[0]).toBe('docs/diagrams/billing-architecture.md')
  })

  it('never touches the plan phases (shape is the template’s job, not seedPlan’s)', () => {
    const before = draftFixture().phases
    const after = preset.seedPlan!(draftFixture(), FULL_INPUTS).phases
    expect(after).toEqual(before)
  })

  it('leaves an item in an unrecognized phase byte-identical', () => {
    const draft = draftFixture()
    draft.items.push({
      id: 'x1',
      phaseId: 'mystery',
      title: 'Off-template',
      description: '',
      dependsOn: [],
    })
    const out = preset.seedPlan!(draft, FULL_INPUTS)
    expect(out.items.find((i) => i.id === 'x1')).toEqual(draft.items.find((i) => i.id === 'x1'))
  })
})

describe('preset_docs_refresh — gate-override matches the spawned pipelines', () => {
  // `docsReviewGates` derives the override from each pipeline's `agentKinds`, so the array is
  // parallel to the pipeline by construction (ExecutionService.start rejects a length mismatch) and
  // the single `true` sits on the merge step.
  const kindsOf = (id: string): readonly string[] =>
    seedPipelines().find((p) => p.id === id)?.agentKinds ?? []

  it.each([DOCUMENT_QUICK_PIPELINE_ID, CODE_COMMENTS_PIPELINE_ID, BUSINESS_DOCS_PIPELINE_ID])(
    'gates the merge step of %s',
    (pipelineId) => {
      const kinds = kindsOf(pipelineId)
      const gates = docsReviewGates(pipelineId, true)
      expect(gates?.length).toBe(kinds.length)
      // Exactly one gate, on the pipeline's `merger` step.
      expect(gates?.filter(Boolean)).toHaveLength(1)
      expect(gates?.[kinds.lastIndexOf('merger')]).toBe(true)
    },
  )

  it('returns undefined when human review is off', () => {
    expect(docsReviewGates(DOCUMENT_QUICK_PIPELINE_ID, false)).toBeUndefined()
  })
})

import type {
  DocKind,
  InitiativeDraftItem,
  InitiativePlanDraft,
  InitiativePresetInputs,
} from '@cat-factory/contracts'
import type { InitiativePresetRegistration } from '@cat-factory/kernel'
import {
  BUSINESS_DOCS_PIPELINE_ID,
  CODE_COMMENTS_PIPELINE_ID,
  DOCUMENT_QUICK_PIPELINE_ID,
  INITIATIVE_DOCS_PIPELINE_ID,
  joinRepoPath,
  registerInitiativePreset,
} from '@cat-factory/kernel'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS, styleFragments } from '@cat-factory/prompt-fragments'
import { fileSlug, mergeGateOverride, strInput, uniqueDocPath } from '../plan-helpers.js'
import { detectDocsLayout } from './docs-detect.logic.js'

// ---------------------------------------------------------------------------
// The Documentation-refresh initiative preset (initiative-presets slice 8) — the pilot that
// proves the preset primitives end to end: a create-time FORM, a repo-detection PREFILL probe
// (slice 6's `detectDocsLayout`), a declarative `phaseTemplate` (the generic shape-enforcement
// from T1/T2 — NOT hand-rolled in `seedPlan`), a `seedPlan` that stamps per-item spawn
// DECORATION only, and `promptAdditions` that turn the analyst into a documentation
// gap-auditor and shape the planner's phases + item granularity.
//
// Given a service (or a frontend), it audits the documentation against the implementation and
// drives it to a full, current set. The user checkboxes which documentation types they want;
// placement defaults to `/docs` with autodetection of the current layout; human review is OFF
// by default (opt-in, mapped to the gate-override seam on the SPAWNED task runs — the plan
// itself runs unattended); and the writing-style fragments are on by default.
//
// GOVERNING SPLIT (the T1/T2 gotcha carried into this slice): plan SHAPE lives in
// `phaseTemplate` + the generic ingest normalizer; per-item DECORATION lives in `seedPlan`.
// They never overlap — `seedPlan` here NEVER touches phases, and the template NEVER stamps items.
//
// See `docs/initiatives/initiative-presets-and-docs-refresh.md` (slice 8).
// ---------------------------------------------------------------------------

/** The docs-refresh preset id (the SPA picker option + the create-flow lookup key). */
export const DOCS_REFRESH_PRESET_ID = 'preset_docs_refresh'

// The documentation types the user checkboxes. Each maps 1:1 to a plan PHASE of the same id
// (except `foundations`, which has no doc-type) — so the planner's phase ids, the phase template,
// and `seedPlan`'s per-phase decoration all key off the SAME strings.
const DOC_TYPE_README = 'readme'
const DOC_TYPE_DIAGRAMS = 'diagrams'
const DOC_TYPE_COMMENTS = 'comments'
const DOC_TYPE_BUSINESS_RULES = 'business-rules'

/** The Foundations phase id (create/normalize the placement dirs before the per-type phases). */
const PHASE_FOUNDATIONS = 'foundations'

/** Field keys frozen on the entity's `presetInputs` (referenced by `seedPlan` + the probe). */
const FIELD_DOC_TYPES = 'docTypes'
const FIELD_DOCS_ROOT = 'docsRoot'
const FIELD_DIAGRAMS_DIR = 'diagramsDir'
const FIELD_BUSINESS_RULES_DIR = 'businessRulesDir'
const FIELD_STYLE_FRAGMENTS = 'styleFragments'
const FIELD_HUMAN_REVIEW = 'humanReview'

const DEFAULT_DOCS_ROOT = 'docs'
const DEFAULT_DIAGRAMS_DIR = 'docs/diagrams'
const DEFAULT_BUSINESS_RULES_DIR = 'docs/business-logic'

// ---------------------------------------------------------------------------
// Descriptor (the SPA-facing form + planning binding + defaults).
// ---------------------------------------------------------------------------

/** The writing-style fragment choices, derived from the Writing-style category (single source). */
const STYLE_FRAGMENT_OPTIONS = styleFragments.map((f) => ({ value: f.id, label: f.title }))

const DESCRIPTOR: InitiativePresetRegistration['descriptor'] = {
  id: DOCS_REFRESH_PRESET_ID,
  presentation: {
    label: 'Documentation refresh',
    icon: 'i-lucide-book-open-text',
    color: '#0ea5e9',
    description:
      'Audit a service’s documentation against its code and drive it to a full, current set — READMEs, diagrams, in-source comments and business rules — mostly unattended.',
  },
  fields: [
    {
      key: FIELD_DOC_TYPES,
      label: 'Documentation to refresh',
      help: 'Which kinds of documentation to audit and bring current.',
      type: 'checkbox-group',
      options: [
        { value: DOC_TYPE_README, label: 'README files' },
        { value: DOC_TYPE_DIAGRAMS, label: 'Architecture & flow diagrams (Mermaid)' },
        { value: DOC_TYPE_COMMENTS, label: 'In-source code comments' },
        { value: DOC_TYPE_BUSINESS_RULES, label: 'Business rules & domain constraints' },
      ],
      defaultValues: [
        DOC_TYPE_README,
        DOC_TYPE_DIAGRAMS,
        DOC_TYPE_COMMENTS,
        DOC_TYPE_BUSINESS_RULES,
      ],
    },
    {
      key: 'placementMode',
      label: 'Documentation placement',
      help: 'Where docs live: one root tree, or per-service (monorepo). Autodetected from the repo.',
      type: 'select',
      options: [
        { value: 'root', label: 'Single root docs tree' },
        { value: 'per-service', label: 'Per-service docs (monorepo)' },
      ],
      default: 'root',
    },
    {
      key: FIELD_DOCS_ROOT,
      label: 'Docs root',
      help: 'The repo-relative directory documentation is written under.',
      type: 'path',
      default: DEFAULT_DOCS_ROOT,
    },
    {
      key: FIELD_DIAGRAMS_DIR,
      label: 'Diagrams directory',
      type: 'path',
      default: DEFAULT_DIAGRAMS_DIR,
      showWhen: { key: FIELD_DOC_TYPES, includes: DOC_TYPE_DIAGRAMS },
    },
    {
      key: FIELD_BUSINESS_RULES_DIR,
      label: 'Business-rules directory',
      type: 'path',
      default: DEFAULT_BUSINESS_RULES_DIR,
      showWhen: { key: FIELD_DOC_TYPES, includes: DOC_TYPE_BUSINESS_RULES },
    },
    {
      key: 'scopeHint',
      label: 'Scope (optional)',
      help: 'Which services or areas to focus on. Leave blank to cover everything in the frame.',
      type: 'textarea',
      placeholder: 'e.g. the billing and notifications services only',
    },
    {
      key: FIELD_HUMAN_REVIEW,
      label: 'Review each documentation change before it merges',
      help: 'Off by default — documentation PRs merge automatically once CI is green. Turn on to pause each spawned task for approval.',
      type: 'checkbox',
    },
    {
      key: FIELD_STYLE_FRAGMENTS,
      label: 'Writing-style guidance',
      help: 'Best-practice writing fragments folded into every documentation task.',
      type: 'checkbox-group',
      options: STYLE_FRAGMENT_OPTIONS,
      defaultValues: [...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS],
    },
  ],
  planningPipelineId: INITIATIVE_DOCS_PIPELINE_ID,
  // The form IS the interview — no interviewer step; the create flow seeds the qa digest from it.
  interview: 'skip',
  // Unattended by default; the `humanReview` field opts INTO per-task gates via `seedPlan`.
  humanReviewDefault: false,
  defaultFragmentIds: [...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS],
  // Plan SHAPE (T1/T2): Foundations is mandatory (place/normalize the docs dirs); each per-type
  // phase is OPTIONAL — the planner emits only the phases whose doc type the user checked (steered
  // by the promptAdditions). `allowAdditionalPhases: false` keeps the plan to this exhaustive set;
  // the generic ingest normalizer reorders to this order and rejects a missing Foundations / an
  // unknown extra phase. Phase ids match VERBATIM the ids the planner emits and `seedPlan` keys off.
  phaseTemplate: {
    phases: [
      {
        id: PHASE_FOUNDATIONS,
        title: 'Foundations',
        goal: 'Create or normalize the documentation placement directories the plan writes into (often 0–1 items).',
        required: true,
      },
      {
        id: DOC_TYPE_README,
        title: 'README refresh',
        goal: 'Bring each in-scope service’s README to a current, useful state.',
      },
      {
        id: DOC_TYPE_DIAGRAMS,
        title: 'Architecture & flow diagrams',
        goal: 'Author Mermaid diagrams for the architecture and the key flows of each in-scope service.',
      },
      {
        id: DOC_TYPE_COMMENTS,
        title: 'In-source comments',
        goal: 'Add and clarify why-not-what comments in the least-documented modules from the audit.',
      },
      {
        id: DOC_TYPE_BUSINESS_RULES,
        title: 'Business rules',
        goal: 'Capture the domain rules and constraints as in-repo documentation, one document per area.',
      },
    ],
    allowAdditionalPhases: false,
  },
}

// ---------------------------------------------------------------------------
// `detect` — the repo-layout PREFILL probe (slice 6's pure detector mapped onto the form).
// ---------------------------------------------------------------------------

/**
 * Prefill the placement fields from the target repo's layout. A `RepoFiles` satisfies slice 6's
 * `DocsRepoReader` structurally, and `detectDocsLayout` is bounded + never throws, so this only
 * ever returns non-binding FORM DEFAULTS (the user's edits win). The detected `hasExistingMermaid`
 * / `monorepo` intel is for the analyst at planning time, not a form field, so it is not returned.
 */
const detect: NonNullable<InitiativePresetRegistration['detect']> = async (repo) => {
  const layout = await detectDocsLayout(repo)
  return {
    placementMode: layout.placementMode,
    [FIELD_DOCS_ROOT]: layout.docsRoot,
    [FIELD_DIAGRAMS_DIR]: layout.diagramsDir,
    [FIELD_BUSINESS_RULES_DIR]: layout.businessRulesDir,
  }
}

// ---------------------------------------------------------------------------
// `seedPlan` — per-item spawn DECORATION only (never plan shape — that is the template's job).
// ---------------------------------------------------------------------------

/**
 * The per-run gate-override array for a spawned documentation pipeline when human review is opted
 * in — the human reviews the CI-green PR right BEFORE it merges, matching the form's "review each
 * documentation change before it merges" promise. The placement is the shared {@link mergeGateOverride}
 * (single derivation across presets); `undefined` when human review is OFF (the default) so the
 * run stays unattended.
 */
export function docsReviewGates(pipelineId: string, humanReview: boolean): boolean[] | undefined {
  return humanReview ? mergeGateOverride(pipelineId) : undefined
}

/** The spawn shape each phase's items take (the deterministic decoration `seedPlan` stamps). */
interface PhaseDecoration {
  pipelineId: string
  taskType?: 'document'
  docKind?: DocKind
  /** How the item's `.md` target path is placed: derived under a dir, or none (writer-placed). */
  placement: 'docs-root' | 'diagrams-dir' | 'none'
}

const PHASE_DECORATIONS: Record<string, PhaseDecoration> = {
  // Foundations: a lean doc under the docs root (writing it creates/normalizes the placement dir).
  [PHASE_FOUNDATIONS]: {
    pipelineId: DOCUMENT_QUICK_PIPELINE_ID,
    taskType: 'document',
    docKind: 'reference',
    placement: 'docs-root',
  },
  // README: a doc that lives BESIDE the code, so its path is per-service and cannot be DERIVED
  // here (seedPlan doesn't know each service's directory). The planner names the README's path in
  // the item description (steered by the promptAdditions) and the doc-writer places it — the same
  // description-placed shape as `comments`/`business-rules`. It CANNOT ride `taskTypeFields.targetPath`:
  // the planner's structured output has no `spawn` field (see `INITIATIVE_PLANNER_SYSTEM_PROMPT`),
  // so `coerceInitiativePlan` never carries one through to `seedPlan`.
  [DOC_TYPE_README]: {
    pipelineId: DOCUMENT_QUICK_PIPELINE_ID,
    taskType: 'document',
    docKind: 'reference',
    placement: 'none',
  },
  // Diagrams: a Mermaid `.md` a doc-writer produces, placed under the diagrams dir. `docKind: other`
  // (there is no `diagrams` DocKind) — its template's required sections (Overview + Details) suit a
  // diagram doc, so `doc-quality` accepts it once the writer includes an overview + the diagrams.
  [DOC_TYPE_DIAGRAMS]: {
    pipelineId: DOCUMENT_QUICK_PIPELINE_ID,
    taskType: 'document',
    docKind: 'other',
    placement: 'diagrams-dir',
  },
  // In-source comments: `code-commenter` edits code in place — NOT a document task, and its scope is
  // a module DIR (which cannot ride `taskTypeFields.targetPath`, that field is `.md`-only). The
  // planner names the module in the item description; the pipeline's CI tail proves behaviour-neutral.
  [DOC_TYPE_COMMENTS]: { pipelineId: CODE_COMMENTS_PIPELINE_ID, placement: 'none' },
  // Business rules: `business-documenter` writes MANY docs under a directory, so there is no single
  // target path — the planner names the business-rules dir in the description (the business-documenter
  // already respects an established docs home). Typed `document` for the SPA's doc affordances.
  [DOC_TYPE_BUSINESS_RULES]: {
    pipelineId: BUSINESS_DOCS_PIPELINE_ID,
    taskType: 'document',
    placement: 'none',
  },
}

/**
 * The derived `.md` target path for an item (undefined when the placement is writer-placed). The
 * composed path is deduplicated by {@link uniqueDocPath} in `seedPlan`, so a title collision never
 * yields two items writing the same file.
 */
function targetPathFor(
  deco: PhaseDecoration,
  item: InitiativeDraftItem,
  inputs: InitiativePresetInputs,
): string | undefined {
  switch (deco.placement) {
    case 'docs-root':
      return `${joinRepoPath(strInput(inputs, FIELD_DOCS_ROOT, DEFAULT_DOCS_ROOT), fileSlug(item.title))}.md`
    case 'diagrams-dir':
      return `${joinRepoPath(strInput(inputs, FIELD_DIAGRAMS_DIR, DEFAULT_DIAGRAMS_DIR), fileSlug(item.title))}.md`
    case 'none':
      return undefined
  }
}

/**
 * Stamp each planner-drafted item with its spawn DECORATION, keyed off the item's phase id: the
 * documentation pipeline to run (`item.pipelineId`), the typed-task fields (`taskType`/`docKind`/a
 * derived `targetPath`), the chosen writing-style `fragmentIds`, and the human-review `gates`
 * override. Pure + total; an item in an unrecognized phase is left byte-identical (defensive — the
 * phase template already constrains the phases). NEVER touches phases or item content — plan shape
 * is the template's job (the generic ingest normalizer runs before AND after this hook).
 */
function seedPlan(draft: InitiativePlanDraft, inputs: InitiativePresetInputs): InitiativePlanDraft {
  const humanReview = inputs[FIELD_HUMAN_REVIEW] === true
  const styleFragmentIds = Array.isArray(inputs[FIELD_STYLE_FRAGMENTS])
    ? (inputs[FIELD_STYLE_FRAGMENTS] as string[])
    : []
  // Track derived `.md` paths across the whole plan so two same-slug items never collide on one file.
  const usedPaths = new Set<string>()

  const items = draft.items.map((item): InitiativeDraftItem => {
    const deco = PHASE_DECORATIONS[item.phaseId]
    if (!deco) return item

    const derived = targetPathFor(deco, item, inputs)
    const targetPath = derived ? uniqueDocPath(derived, usedPaths) : undefined
    const taskTypeFields = {
      ...(deco.docKind ? { docKind: deco.docKind } : {}),
      ...(targetPath ? { targetPath } : {}),
    }
    const gates = docsReviewGates(deco.pipelineId, humanReview)
    // Merge OVER any planner-authored spawn (so a planner `agentConfig` etc. survives) — the
    // decorated fields we own win.
    const spawn = {
      ...item.spawn,
      ...(deco.taskType ? { taskType: deco.taskType } : {}),
      ...(Object.keys(taskTypeFields).length ? { taskTypeFields } : {}),
      ...(styleFragmentIds.length ? { fragmentIds: styleFragmentIds } : {}),
      ...(gates ? { gates } : {}),
    }

    return {
      ...item,
      pipelineId: deco.pipelineId,
      ...(Object.keys(spawn).length ? { spawn } : {}),
    }
  })

  return { ...draft, items }
}

// ---------------------------------------------------------------------------
// `promptAdditions` — per-kind planning-prompt steering (DATA, off the wire descriptor). Provides
// the METHODOLOGY; the frozen form (which types, placement dirs, scope) reaches the prompt via the
// seeded qa digest, so these never restate the form values.
// ---------------------------------------------------------------------------

const ANALYST_STEERING = [
  'You are a DOCUMENTATION GAP-AUDITOR for this initiative. For each documentation type the user',
  'requested (see the planning interview above — READMEs, diagrams, in-source comments, business',
  'rules), inventory what documentation already exists across every in-scope service and module,',
  'then compare it against the actual implementation and classify each as MISSING, STALE (present',
  'but out of date with the code) or ADEQUATE.',
  '',
  '- Ground every finding in a concrete path (the file/module/service it concerns) — no vague',
  '  "docs could be improved". Note where docs already live so the plan reuses that home.',
  '- For in-source comments, identify the modules whose logic is hardest to follow and least',
  '  commented; for business rules, the distinct domain areas.',
  '- Respect the requested scope and placement directories from the interview. Your analysis is the',
  '  audit the planner turns into concrete, per-service items — make it specific and complete.',
].join('\n')

const PLANNER_STEERING = [
  'Build the plan around the required plan shape above, following the documentation audit. Include a',
  'phase ONLY for a documentation type the user requested; omit the others (they are optional).',
  '',
  'Phase `foundations`: ALWAYS present it (the required plan shape mandates it), but give it an item',
  'ONLY to create or normalize a MISSING placement directory a later phase writes into — usually 0–1',
  'items, and leave it with NO items when the directories already exist. Never drop the phase itself.',
  '',
  'Bounded item granularity per phase:',
  '- `readme` — one item per in-scope service. Its README lives BESIDE the code, so name the exact',
  '  repo-relative path (e.g. `services/auth/README.md`) in the item description for the writer.',
  '- `diagrams` — one item per in-scope service (architecture + the key flows), written under the',
  '  diagrams directory from the interview.',
  '- `comments` — one item per worst under-documented module from the audit, capped at 5; name the',
  '  module to comment in the item description.',
  '- `business-rules` — one item per distinct domain area, committed under the business-rules',
  '  directory from the interview.',
  '',
  'Write each item’s description to be self-sufficient (a spawned task runs it in isolation): what to',
  'document, for which service/module, where it goes, and what the audit found missing or stale.',
].join('\n')

// ---------------------------------------------------------------------------
// Registration (the module-global preset seam — mirrors the `@cat-factory/gates` side-effect).
// ---------------------------------------------------------------------------

/** The docs-refresh preset registration bundle (descriptor + code hooks). */
export const DOCS_REFRESH_PRESET: InitiativePresetRegistration = {
  descriptor: DESCRIPTOR,
  detect,
  seedPlan,
  promptAdditions: {
    'initiative-analyst': ANALYST_STEERING,
    'initiative-planner': PLANNER_STEERING,
  },
}

/**
 * Register the docs-refresh preset. Idempotent (the registry replaces by id), so importing this
 * module (which self-registers below, the `@cat-factory/gates` pattern) and calling this explicitly
 * are safe to combine. Tests that `clearRegisteredInitiativePresets()` call this to restore it.
 */
export function registerDocsRefreshPreset(): void {
  registerInitiativePreset(DOCS_REFRESH_PRESET)
}

// Side-effect registration: importing `@cat-factory/agents` (which re-exports from this module) is
// enough to make the pilot preset available in every deployment — no per-facade wiring, so the two
// runtimes cannot drift on it.
registerDocsRefreshPreset()

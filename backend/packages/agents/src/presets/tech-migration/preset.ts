import type { InitiativePresetRegistration } from '@cat-factory/kernel'
import { INITIATIVE_PIPELINE_ID, registerInitiativePreset } from '@cat-factory/kernel'
import { MIGRATION_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { MIGRATION_PHASE_IDS } from './phases.js'
import { MIGRATION_PROMPT_ADDITIONS } from './prompt-additions.js'
import {
  DEFAULT_MIGRATION_DOCS_DIR,
  FIELD_HUMAN_REVIEW,
  FIELD_MIGRATION_DOCS_DIR,
  seedMigrationPlan,
} from './seed-plan.js'

// ---------------------------------------------------------------------------
// The `preset_tech_migration` initiative preset (tech-migration slice T8) — the second real
// consumer of the initiative-preset primitives, and the one that proves "preset as a MANDATED
// MULTI-PHASE METHODOLOGY" (where docs-refresh proved "preset as form + typed spawned tasks").
//
// A technological migration — swapping a database engine, a framework major, a runtime, or a
// load-bearing library — is the highest-risk initiative shape the product runs: the change is
// wide, mostly mechanical, and catastrophic when observable behaviour drifts. What makes it safe
// is the discipline around it (know the blast zone, pin behaviour BEFORE the swap, decide the
// compat degree deliberately, deliver, then remove the old path), and that discipline is invariant
// across migrations. This preset encodes HOW: the user tells the form WHICH migration, and the
// preset mandates the five-phase plan shape + the confidence-case control point.
//
// The division of labour is inverted from a naive "human signs off on coverage" gate: estimating a
// migration's blast zone by eye is near-impossible for a human but exactly what an agent is good
// at, so the LLM performs the whole-codebase impact/coverage sweep and submits an evidence-backed
// confidence case, and the human's job is to REVISE that proof (challenge grounding, reject
// hand-waving, then approve). Hence `interview: 'full'` + `humanReviewDefault: true` + the
// always-gated confidence-case / transition-design documents (wired by `seedMigrationPlan`).
//
// This slice is pure WIRING — it composes the already-landed pieces and adds nothing new:
//   - the plan SHAPE is the wire `phaseTemplate` (the generic T1/T2 machinery enforces it — this
//     preset NEVER hand-rolls phase shaping), keyed off the canonical `MIGRATION_PHASE_IDS` (T5);
//   - the per-item spawn DECORATION is `seedMigrationPlan` (T7), keyed off `item.phaseId`;
//   - the deep per-kind methodology is `MIGRATION_PROMPT_ADDITIONS` (T5), off the wire descriptor;
//   - the behaviour-preservation fragments are `MIGRATION_FRAGMENT_IDS` (T4).
// It registers as an import side effect (the `@cat-factory/gates` / docs-refresh pattern), so both
// runtimes pick it up with no per-facade wiring and cannot drift.
//
// NO `detect` hook (so the descriptor's derived `probe` is false): a create-time probe could read
// only the FROM-side stack, never the destination or the migration intent, and the analyst
// rediscovers the whole blast zone far more thoroughly at planning time — see the tracker's
// "Out of scope" for why the former T6 detector was cut.
//
// See `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md` (slice T8).
// ---------------------------------------------------------------------------

/** The tech-migration preset id (the SPA picker option + the create-flow lookup key). */
export const TECH_MIGRATION_PRESET_ID = 'preset_tech_migration'

// Form field keys. The two consumed by `seedMigrationPlan` (T7) — `migrationDocsDir` + `humanReview`
// — are defined ONCE there and imported here so the field key / default never drifts between the
// form descriptor and the plan post-processor. The rest are steering-only: they freeze on
// `presetInputs` and reach the interviewer/analyst/planner through the seeded qa digest.
const FIELD_MIGRATION_KIND = 'migrationKind'
const FIELD_FROM_TECH = 'fromTech'
const FIELD_TO_TECH = 'toTech'
const FIELD_MIGRATION_DETAIL = 'migrationDetail'
const FIELD_STORED_PROC_POLICY = 'storedProcPolicy'
const FIELD_COMPAT_POSTURE = 'compatPosture'
const FIELD_BEHAVIOUR_CONTRACT = 'behaviourContract'
const FIELD_COVERAGE_BAR = 'coverageBar'
const FIELD_SCOPE_HINT = 'scopeHint'

// Select option values (referenced by both the options list and the `showWhen` condition).
const MIGRATION_KIND_DATABASE = 'database'
const STORED_PROC_POLICY_REPLACE = 'replace-with-app-code'
const COVERAGE_BAR_STRICT = 'strict'

// ---------------------------------------------------------------------------
// Descriptor (the SPA-facing form + planning binding + defaults + plan-shape template).
// ---------------------------------------------------------------------------

const DESCRIPTOR: InitiativePresetRegistration['descriptor'] = {
  id: TECH_MIGRATION_PRESET_ID,
  presentation: {
    label: 'Technological migration',
    icon: 'i-lucide-database-zap',
    color: '#f59e0b',
    description:
      'Swap a load-bearing technology (database, framework major, runtime) behind a behaviour-preservation safety net: blast zone → coverage → transition design → delivery → decommission.',
  },
  fields: [
    {
      key: FIELD_MIGRATION_KIND,
      label: 'Which migration',
      help: 'The kind of load-bearing technology being swapped.',
      type: 'select',
      required: true,
      options: [
        { value: MIGRATION_KIND_DATABASE, label: 'Database engine' },
        { value: 'framework-major', label: 'Framework major version' },
        { value: 'runtime', label: 'Language runtime' },
        { value: 'library-swap', label: 'Load-bearing library' },
        { value: 'other', label: 'Other' },
      ],
    },
    {
      key: FIELD_FROM_TECH,
      label: 'From',
      help: 'The technology being migrated away from.',
      type: 'text',
      required: true,
      placeholder: 'e.g. MSSQL 2019 + stored procedures',
    },
    {
      key: FIELD_TO_TECH,
      label: 'To',
      help: 'The technology being migrated to.',
      type: 'text',
      required: true,
      placeholder: 'e.g. PostgreSQL 16',
    },
    {
      key: FIELD_MIGRATION_DETAIL,
      label: 'Scope & concerns (optional)',
      help: 'Anything the analyst should dig into — specific subsystems, known risks, deadlines.',
      type: 'textarea',
      placeholder: 'e.g. the reporting queries and the nightly settlement job are the risky parts',
    },
    {
      key: FIELD_STORED_PROC_POLICY,
      label: 'Stored-procedure policy',
      help: 'How to handle stored procedures during the swap.',
      type: 'select',
      default: STORED_PROC_POLICY_REPLACE,
      options: [
        { value: STORED_PROC_POLICY_REPLACE, label: 'Replace with application code + SQL' },
        { value: 'port-to-target', label: 'Port to the target engine' },
        { value: 'decide-per-object', label: 'Decide per object' },
      ],
      showWhen: { key: FIELD_MIGRATION_KIND, equals: MIGRATION_KIND_DATABASE },
    },
    {
      key: FIELD_COMPAT_POSTURE,
      label: 'Compatibility posture (optional)',
      help: 'How long the old and new technologies run side by side. Leave unset for phase 3 to recommend.',
      type: 'select',
      options: [
        { value: 'big-bang', label: 'Big-bang cutover' },
        { value: 'dual-run', label: 'Dual-run (old + new in parallel)' },
        { value: 'adapter-layer', label: 'Adapter layer' },
      ],
    },
    {
      key: FIELD_BEHAVIOUR_CONTRACT,
      label: 'Behaviour that must not change (optional)',
      help: 'The observable behaviour the migration must preserve — the phase-2 characterization target.',
      type: 'textarea',
      placeholder: 'e.g. result ordering, error codes the client branches on, pagination stability',
    },
    {
      key: FIELD_MIGRATION_DOCS_DIR,
      label: 'Migration docs directory',
      help: 'Where the blast-zone / confidence-case / transition-design artifacts are committed.',
      type: 'path',
      required: true,
      default: DEFAULT_MIGRATION_DOCS_DIR,
    },
    {
      key: FIELD_COVERAGE_BAR,
      label: 'Coverage bar',
      help: 'How strict the behaviour-coverage requirement is before delivery may begin.',
      type: 'select',
      required: true,
      default: COVERAGE_BAR_STRICT,
      options: [
        { value: COVERAGE_BAR_STRICT, label: 'Strict — every touchpoint has named covering tests' },
        { value: 'pragmatic', label: 'Pragmatic — waivers allowed, each justified' },
      ],
    },
    {
      key: FIELD_HUMAN_REVIEW,
      label: 'Review each change before it merges',
      help: 'On by default for a migration — the confidence case and transition design are always human-gated; this additionally gates the informational blast-zone report and the delivery PRs.',
      type: 'checkbox',
      default: 'true',
    },
    {
      key: FIELD_SCOPE_HINT,
      label: 'Scope hint (optional)',
      help: 'Which services or areas to focus on. Steers the analyst’s blast-zone sweep.',
      type: 'textarea',
      placeholder: 'e.g. the orders and billing services only',
    },
  ],
  // A migration needs exactly interviewer → analyst → planner(gate) → committer, so it binds the
  // EXISTING `pl_initiative` planning pipeline — no new planning pipeline is registered; all
  // deviation is data (this descriptor + the phase template) and hooks (`seedMigrationPlan` +
  // `promptAdditions`).
  planningPipelineId: INITIATIVE_PIPELINE_ID,
  // Full interview: the form captures the enumerable facts, the interviewer digs into the fuzzy
  // ones (downtime tolerance, data-migration constraints, compat posture) — see the T5 interviewer
  // prompt addition. The create flow seeds the qa digest so the interviewer builds on the form
  // answers rather than re-asking them (the generic T3 seeding).
  interview: 'full',
  // Migrations stay human-in-the-loop by design; the human audits the confidence case + design.
  humanReviewDefault: true,
  // The full behaviour-preservation / migration-discipline / confidence-case fragment set (T4).
  // `seedMigrationPlan` stamps the per-item SUBSET that applies to each producer at ingest, so this
  // is the superset available to the planning steps.
  defaultFragmentIds: [...MIGRATION_FRAGMENT_IDS],
  // Conservative execution policy: low concurrency (migration PRs collide), risky/complex items
  // escalate to the full pipeline, and an unestimated item fails SAFE to thoroughness.
  policyDefaults: {
    maxConcurrent: 2,
    defaultPipelineId: 'pl_quick',
    rules: [{ pipelineId: 'pl_full', minRisk: 0.6, minComplexity: 0.6 }],
    onMissingEstimate: 'strongest',
  },
  // Plan SHAPE (T1/T2): the five migration phases, ALL required, in methodology order, no extras.
  // The ids are the canonical `MIGRATION_PHASE_IDS` (T5) — matched VERBATIM by the generic ingest
  // normalizer against the planner's phases, and keyed off by `seedMigrationPlan`'s decoration.
  // The generic normalizer reorders to this order and rejects a missing phase / an unknown extra;
  // the deep per-phase methodology stays off the descriptor in `MIGRATION_PROMPT_ADDITIONS`.
  phaseTemplate: {
    phases: [
      {
        id: MIGRATION_PHASE_IDS.blastZone,
        title: 'Blast zone',
        goal: 'Enumerate every directly and transitively affected touchpoint of the technology being swapped and commit the inventory.',
        required: true,
      },
      {
        id: MIGRATION_PHASE_IDS.coverage,
        title: 'Coverage hardening',
        goal: 'Pin the observable behaviour over the blast zone with tests at a seam above the swapped layer, closing with the confidence case.',
        required: true,
      },
      {
        id: MIGRATION_PHASE_IDS.transitionDesign,
        title: 'Compatibility & transition design',
        goal: 'Decide the backwards-compatibility degree and design the migration / cutover path.',
        required: true,
      },
      {
        id: MIGRATION_PHASE_IDS.delivery,
        title: 'Delivery',
        goal: 'Execute the swap per the approved design, with the behaviour suite green throughout.',
        required: true,
      },
      {
        id: MIGRATION_PHASE_IDS.verifyDecommission,
        title: 'Verify & decommission',
        goal: 'Prove behaviour parity on the new target, flip defaults / CI, and remove the old path per the compatibility posture.',
        required: true,
      },
    ],
    allowAdditionalPhases: false,
  },
}

// ---------------------------------------------------------------------------
// Registration (the module-global preset seam — mirrors the `@cat-factory/gates` side-effect).
// ---------------------------------------------------------------------------

/**
 * The tech-migration preset registration bundle: the descriptor above, the T7 `seedMigrationPlan`
 * post-processor as `seedPlan` (per-item spawn decoration + the confidence-case wiring), and the T5
 * methodology prompt pack as `promptAdditions`. No `detect` hook (see the file header).
 */
export const TECH_MIGRATION_PRESET: InitiativePresetRegistration = {
  descriptor: DESCRIPTOR,
  seedPlan: seedMigrationPlan,
  promptAdditions: MIGRATION_PROMPT_ADDITIONS,
}

/**
 * Register the tech-migration preset. Idempotent (the registry replaces by id), so importing this
 * module (which self-registers below, the `@cat-factory/gates` pattern) and calling this explicitly
 * are safe to combine. Tests that `clearRegisteredInitiativePresets()` call this to restore it.
 */
export function registerTechMigrationPreset(): void {
  registerInitiativePreset(TECH_MIGRATION_PRESET)
}

// Side-effect registration: importing `@cat-factory/agents` (which re-exports from this module) is
// enough to make the migration preset available in every deployment — no per-facade wiring, so the
// two runtimes cannot drift on it.
registerTechMigrationPreset()

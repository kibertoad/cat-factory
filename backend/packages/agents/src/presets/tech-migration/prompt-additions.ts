import type { AgentKind } from '@cat-factory/kernel'
import {
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
} from '@cat-factory/kernel'
import { MIGRATION_PHASE_IDS } from './phases.js'

// ---------------------------------------------------------------------------
// The methodology PROMPT PACK for the `preset_tech_migration` initiative preset — the per-planning-
// kind steering text the preset registers as its `promptAdditions` (T8). This is the DEEP,
// code-side methodology the parent's off-the-wire rule keeps OUT of the descriptor: the wire
// `phaseTemplate` carries only short phase ids/titles/goals (rendered as the "required plan
// shape"), while these constants carry HOW each planning kind reasons about a migration.
//
// How each constant reaches its agent:
//   - `initiative-analyst` / `initiative-planner` run through the engine, so `AgentContextBuilder`
//     resolves `promptAdditions[kind]` onto `context.initiative.preset.promptAddition` and the
//     server's `initiativeContextLines` renders it under `## Initiative preset: <label>` (the
//     planner also gets the `phaseTemplate` fold). This seam already existed (T1 / parent S3).
//   - `initiative-interviewer` is the INLINE `InitiativeInterviewService`, which folds
//     `promptAdditions[INITIATIVE_INTERVIEWER_AGENT_KIND]` into its own prompt — a generic seam this
//     slice completes, since the migration preset is the first FULL-interview preset to need it
//     (docs-refresh is `interview: 'skip'`).
//
// Everything is DATA: the preset registration (T8) spreads `MIGRATION_PROMPT_ADDITIONS`, and the
// loop never branches on a preset id. The planner brief references the canonical phase ids from
// `phases.ts` so they are never retyped. See
// `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`.
// ---------------------------------------------------------------------------

/**
 * Interviewer steering: the migration form already froze the enumerable facts (which migration,
 * from/to tech, stored-proc policy, compat posture, coverage bar, docs dir), so the interview digs
 * into the fuzzy, judgment-dependent facts a form cannot capture — the ones that actually change how
 * the migration must be planned. Complements the generic T3 "build on the seeded form" line with the
 * migration-specific probing agenda.
 */
export const MIGRATION_INTERVIEWER_PROMPT_ADDITION = [
  'This initiative is a TECHNOLOGICAL MIGRATION — swapping a load-bearing technology (a database ' +
    'engine, a framework major, a runtime, a core library) behind a behaviour-preservation safety ' +
    'net. The intake form has already captured the enumerable facts (which migration, the from/to ' +
    'technology, the stored-procedure policy, the compatibility posture, the coverage bar, the docs ' +
    'location). Treat every one of those seeded answers as SETTLED — never re-ask what the form covers.',
  '',
  'Spend your questions on the fuzzy, judgment-dependent facts a form cannot capture, because they ' +
    'shape the plan:',
  '- Downtime / cutover tolerance: is a maintenance window acceptable, or must the switch be online?',
  '- Data-migration constraints: data volume, backfill and rehearsal needs, point-in-time ' +
    'correctness, and any records that cannot be recreated.',
  '- Compatibility posture, when the form left it unset: how long must the old and new technologies ' +
    'run side by side (big-bang vs dual-run vs adapter layer), and what forces that choice?',
  '- The observable behaviour that must NOT change, and where silent drift is most likely.',
  '- Rollback expectations, and who owns the decision to abort a cutover mid-flight.',
  '- Operational reach: scheduled jobs, ops tooling, monitoring and CI that touch the technology ' +
    'being swapped.',
  '',
  'Keep each batch small and high-leverage. Converge as soon as the migration methodology (blast ' +
    'zone → coverage → transition → delivery → decommission) can be planned unambiguously.',
].join('\n')

/**
 * Analyst steering: the analysis must produce the migration's BLAST ZONE (the touchpoint inventory
 * the planner turns into the phase-1 report item and the provisional phase-2 coverage items), not a
 * generic architecture overview — and it must chase the TRANSITIVE reach where migrations silently
 * break, recording the existing test coverage per touchpoint (the phase-2 hardening target and the
 * confidence case's grounding).
 */
export const MIGRATION_ANALYST_PROMPT_ADDITION = [
  'This initiative is a TECHNOLOGICAL MIGRATION. Your analysis must produce the migration BLAST ' +
    'ZONE — the touchpoint inventory the planner turns into the phase-1 report item and the ' +
    'provisional phase-2 coverage items — not a generic architecture overview.',
  '',
  'Enumerate every touchpoint of the technology being swapped:',
  '- DIRECT touchpoints: every site that uses the technology directly — queries, driver/ORM calls, ' +
    'schema objects, vendor-specific idioms, connection/pool/timeout config.',
  '- TRANSITIVE touchpoints: chase the reach BEYOND the direct sites — callers of those callers, ' +
    'code that consumes the RESULT SHAPES or error contracts of the swapped calls, scheduled jobs, ' +
    'ops and migration tooling, monitoring, and CI provisioning. Transitive reach is where ' +
    'migrations silently break; do not stop at the obvious layer.',
  '',
  'For EACH touchpoint record: what it is, whether it is direct or transitive, a risk assessment, ' +
    'and — critically — WHICH TESTS COVER IT TODAY (or "none"). That "covered by which tests today" ' +
    'column is exactly what phase 2 hardens and the confidence case audits, so ground it in real ' +
    'test files, not guesses.',
  '',
  'Call out the behaviour-preservation traps specific to THIS swap — the edge cases that differ ' +
    'silently between the two technologies (NULL vs empty string, precision/rounding, collation and ' +
    'comparison semantics, pagination, identity/sequence exposure) — and any set-based operation ' +
    'that must NOT become an app-side per-row loop. Ground every touchpoint in real file/directory ' +
    'references, and produce this provisional inventory IN your analysis so the planner can author ' +
    'phase 1 and the provisional phase-2 items directly from it.',
].join('\n')

/**
 * Planner steering: author each phase's items to the migration briefs, using the canonical phase
 * ids VERBATIM, enforcing coverage-before-delivery and the single-writer artifact discipline. Pairs
 * with the wire `phaseTemplate` (which dictates the phase SHAPE) — this is the per-phase ITEM
 * methodology `seedMigrationPlan` (T7) then decorates and hardens.
 */
export const MIGRATION_PLANNER_PROMPT_ADDITION = [
  'This initiative is a TECHNOLOGICAL MIGRATION, planned around the five fixed phases in the ' +
    "required plan shape above. Author each phase's items to the briefs below, using each phase " +
    '`id` VERBATIM. Coverage comes BEFORE delivery: never schedule a delivery item before the ' +
    'behaviour it changes is characterised and green on the current technology.',
  '',
  `- \`${MIGRATION_PHASE_IDS.blastZone}\`: ONE report item (a SINGLE writer) that verifies and ` +
    "deepens the analyst's provisional inventory against the real code and commits it as a " +
    'Markdown document. Do not split the inventory across parallel writers.',
  `- \`${MIGRATION_PHASE_IDS.coverage}\`: one coverage item per area of the provisional inventory ` +
    '(keep it to roughly eight; group finer-grained rows by area), each writing characterization ' +
    'tests at a seam ABOVE the layer being swapped so they survive the swap. CLOSE the phase with a ' +
    'single confidence-case item that depends on every other phase-2 item and is human-gated: it ' +
    'sweeps coverage and commits the evidence-backed proof (per-touchpoint named tests, gaps and ' +
    'waivers justified against the coverage bar, risk mitigations, safety nets) a human audits ' +
    'before delivery.',
  `- \`${MIGRATION_PHASE_IDS.transitionDesign}\`: one or two human-gated design items that decide ` +
    'the backwards-compatibility posture and design the migration / cutover path — schema ' +
    'translation, transaction-boundary ownership, the error-contract mapping, the per-object ' +
    'replacement strategy, and the data-migration path plus rehearsal — committing the design ' +
    'document. Each set-based operation replaced with application code needs an explicit note that ' +
    'it stays set-based (never an app-side per-row loop).',
  `- \`${MIGRATION_PHASE_IDS.delivery}\`: delivery items batched by design area, each depending on ` +
    'the enabling schema / infrastructure item, executed per the approved design with the behaviour ' +
    'suite green throughout.',
  `- \`${MIGRATION_PHASE_IDS.verifyDecommission}\`: a parity-verification item (the behaviour suite ` +
    'green on the new target, made primary), the CI / default flip, and removal of the old path and ' +
    'its dependencies per the chosen compatibility posture.',
].join('\n')

/**
 * The migration preset's `promptAdditions` map — the per-planning-kind steering the registration
 * (T8) spreads onto its {@link InitiativePresetRegistration}. Keyed by the kernel agent-kind
 * constants so a kind rename can't silently orphan an entry.
 */
export const MIGRATION_PROMPT_ADDITIONS: Partial<Record<AgentKind, string>> = {
  [INITIATIVE_INTERVIEWER_AGENT_KIND]: MIGRATION_INTERVIEWER_PROMPT_ADDITION,
  [INITIATIVE_ANALYST_AGENT_KIND]: MIGRATION_ANALYST_PROMPT_ADDITION,
  [INITIATIVE_PLANNER_AGENT_KIND]: MIGRATION_PLANNER_PROMPT_ADDITION,
}

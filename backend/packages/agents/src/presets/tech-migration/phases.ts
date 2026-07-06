// ---------------------------------------------------------------------------
// The canonical PHASE IDS of the `preset_tech_migration` initiative preset.
//
// A technological migration always runs the same five-phase methodology (blast zone →
// coverage → transition → delivery → decommission), regardless of the specific from/to
// technologies. Those phase ids are a CONTRACT shared by four consumers:
//   - the preset's declarative `phaseTemplate` on the wire descriptor (T8),
//   - the methodology prompt pack's planner steering (`prompt-additions.ts`, T5),
//   - the plan post-processor `seedMigrationPlan` (T7), and
//   - the migration E2E (T10).
// Defined ONCE here so no consumer retypes a phase id. This matters because the generic
// ingest normalizer matches a planned phase to a template phase by its `id` VERBATIM, so a
// single typo would silently break the shape enforcement (a "missing required phase" reject
// or a disallowed extra) rather than fail loudly. See
// `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`.
// ---------------------------------------------------------------------------

/**
 * The five migration phase ids, keyed by a semantic name so prose/prompts reference a phase by
 * meaning rather than by a bare string. The string values are the ids matched VERBATIM against the
 * planned phases at ingest.
 */
export const MIGRATION_PHASE_IDS = {
  /** Enumerate every directly + transitively affected touchpoint; commit the inventory. */
  blastZone: 'migration-blast-zone',
  /** Pin observable behaviour over the blast zone; close with the confidence case. */
  coverage: 'migration-coverage',
  /** Decide the backwards-compatibility degree and design the migration / cutover path. */
  transitionDesign: 'migration-transition-design',
  /** Execute the swap per the approved design, behaviour suite green throughout. */
  delivery: 'migration-delivery',
  /** Prove parity on the new target, flip defaults, remove the old path. */
  verifyDecommission: 'migration-verify-decommission',
} as const

/** One of the five canonical migration phase ids. */
export type MigrationPhaseId = (typeof MIGRATION_PHASE_IDS)[keyof typeof MIGRATION_PHASE_IDS]

/**
 * The phase ids in methodology order — the order the plan (and the preset's `phaseTemplate`) must
 * present them. Consumers that iterate phases (the template builder, the E2E) read this so the
 * order lives in one place too.
 */
export const MIGRATION_PHASE_ID_ORDER: readonly MigrationPhaseId[] = [
  MIGRATION_PHASE_IDS.blastZone,
  MIGRATION_PHASE_IDS.coverage,
  MIGRATION_PHASE_IDS.transitionDesign,
  MIGRATION_PHASE_IDS.delivery,
  MIGRATION_PHASE_IDS.verifyDecommission,
]

// ---------------------------------------------------------------------------
// Workspace-delete cascade: the single source of truth for every table that is
// reclaimed by a plain `DELETE ... WHERE workspace_id = ?` when a board is
// deleted. Both runtime facades' `WorkspaceRepository.delete` drive their cascade
// from THIS list (D1 builds `DELETE FROM <t> WHERE workspace_id = ?` strings; the
// Drizzle facade issues the same statement per table), so a new workspace-scoped
// table cannot silently miss the cascade and orphan forever — a completeness test
// asserts every table with a `workspace_id` column is either listed here or is one
// of the deliberately-special cases below.
//
// Historically the cascade cleared only 7 tables (blocks/pipelines/agent_runs/…),
// leaving every other workspace-scoped table (notifications, requirement_reviews,
// the review/session/settings/connection tables, …) orphaned permanently on a
// board delete. Listing them here fixes that with one authoritative list.
//
// NOTE ON FK ORDER: the schema declares essentially no foreign keys between
// workspace-scoped tables (Postgres has only a handful of `users` FKs, D1 does not
// enforce FKs at all), so these deletes have no ordering constraints among
// themselves and may run in any order. The ONE ordering constraint the cascade
// still honours lives OUTSIDE this list: the account-owned `services` rows (and the
// board mounts of them) must be reclaimed BEFORE `blocks` is emptied, because that
// reclaim reads `blocks` (a service is found via its `frame_block_id`). The facade
// runs the bespoke service/mount handling first, then this list, then `workspaces`.
// ---------------------------------------------------------------------------

/**
 * Every workspace-scoped table cleared by a plain `DELETE ... WHERE workspace_id = ?`
 * on board deletion. Drives BOTH facades' cascade so they can't drift.
 *
 * Deliberately EXCLUDED (handled specially, NOT by this list):
 * - `workspaces` — the root row, deleted LAST after everything it owns.
 * - `workspace_services` — the board↔service mount join, reclaimed by the bespoke
 *   two-variant handling (every board's mount of a service this board homes, plus
 *   this board's own mounts of services homed elsewhere).
 * - `services` — account-scoped (no `workspace_id`; keyed by frame block), re-homed
 *   or reclaimed by the bespoke shared-service handling that must precede `blocks`.
 * - `binary_artifacts` — its rows are only half the story: the backing blob BYTES
 *   (R2 / S3 / filesystem) must be deleted through the `BinaryBlobBackend` port at
 *   the service layer, not by bare SQL. Deleting the metadata row here would strand
 *   the bytes forever (the row is the only handle on the blob key). Reclaimed by the
 *   workspace-delete blob purge instead. (Until that lands, these rows continue to
 *   orphan exactly as before — no regression from this list.)
 * - Runtime-specific tables that only exist on one facade (e.g. the Cloudflare-only
 *   `live_containers` Durable-Object tracking table) are appended by that facade.
 */
export const WORKSPACE_SCOPED_TABLES = [
  'agent_runs',
  'blocks',
  'brainstorm_sessions',
  'clarity_reviews',
  'consensus_sessions',
  'custom_manifest_types',
  'doc_interview_sessions',
  'document_connections',
  'documents',
  'environment_connections',
  'environment_user_handlers',
  'environments',
  'github_branches',
  'github_check_runs',
  'github_commits',
  'github_installations',
  'github_issues',
  'github_pull_requests',
  'github_repos',
  'incident_enrichment_connections',
  'initiatives',
  'kaizen_gradings',
  'kaizen_verified_combos',
  'merge_threshold_presets',
  'model_presets',
  'notifications',
  'observability_connections',
  'package_registry_connections',
  'pipeline_schedule_runs',
  'pipeline_schedules',
  'pipelines',
  'provider_model_catalog',
  'provider_subscription_tokens',
  'public_api_keys',
  'reference_architectures',
  'release_health_configs',
  'requirement_reviews',
  'runner_pool_connections',
  'shared_stacks',
  'slack_settings',
  'task_connections',
  'task_source_settings',
  'tasks',
  'test_secrets',
  'token_usage',
  'tracker_settings',
  'workspace_fragment_defaults',
  'workspace_settings',
] as const

export type WorkspaceScopedTable = (typeof WORKSPACE_SCOPED_TABLES)[number]

/**
 * Tables that carry a `workspace_id` column but are NOT in {@link WORKSPACE_SCOPED_TABLES}
 * because they are reclaimed by bespoke handling (or deferred to the blob purge). The
 * cascade-completeness test uses this to distinguish "deliberately special" from "silently
 * forgotten": a new `workspace_id` table must be added to the list above or acknowledged here.
 */
export const WORKSPACE_CASCADE_SPECIAL_TABLES = ['workspace_services', 'binary_artifacts'] as const

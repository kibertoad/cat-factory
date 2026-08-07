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
 * - `spend_days`: the durable cost-attribution rollup, deliberately NOT reclaimed at all
 *   (see {@link WORKSPACE_CASCADE_SPECIAL_TABLES}).
 * - `binary_artifacts` — its rows are only half the story: the backing blob BYTES
 *   (R2 / S3 / filesystem) must be deleted through the `BinaryBlobBackend` port at
 *   the service layer, not by bare SQL. Deleting the metadata row here would strand
 *   the bytes forever (the row is the only handle on the blob key). Reclaimed instead
 *   by `WorkspaceService.delete`, which purges rows + bytes together through the
 *   `BinaryArtifactStore.deleteByWorkspace` port BEFORE this cascade runs.
 * - Runtime-specific tables that only exist on one facade (e.g. the Cloudflare-only
 *   `live_containers` Durable-Object tracking table) are appended by that facade.
 */
export const WORKSPACE_SCOPED_TABLES = [
  'agent_prompt_revisions',
  'agent_runs',
  'blocks',
  'brainstorm_sessions',
  'capability_credentials',
  'clarity_reviews',
  'consensus_groups',
  'consensus_sessions',
  'custom_manifest_types',
  'doc_interview_sessions',
  'document_connections',
  'documents',
  'environment_connections',
  'environment_test_runs',
  'environment_user_handlers',
  'environments',
  'gate_outcomes',
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
  'mcp_oauth_grants',
  'merge_threshold_presets',
  'merge_track_records',
  'model_presets',
  'notification_webhooks',
  'notifications',
  'observability_connections',
  'package_registry_connections',
  'pipeline_schedule_runs',
  'pipeline_schedules',
  'pipelines',
  'platform_run_days',
  'provider_model_catalog',
  'provider_subscription_tokens',
  'public_api_keys',
  'reference_architectures',
  'release_health_configs',
  'requirement_reviews',
  'review_question_posts',
  'runner_pool_connections',
  'shared_stacks',
  'slack_settings',
  'task_connections',
  'task_source_settings',
  'task_type_suppressions',
  'tasks',
  'test_secrets',
  'tracker_comment_ingests',
  'token_usage',
  'tracker_settings',
  'validation_configs',
  'workspace_agent_settings',
  'workspace_fragment_defaults',
  'workspace_members',
  'workspace_settings',
] as const

export type WorkspaceScopedTable = (typeof WORKSPACE_SCOPED_TABLES)[number]

/**
 * Tables that carry a `workspace_id` column but are NOT in {@link WORKSPACE_SCOPED_TABLES}:
 * either reclaimed by bespoke handling (deferred to the blob purge, or to the two-variant
 * mount handling) or, in one case, deliberately not reclaimed at all. The
 * cascade-completeness test uses this to distinguish "deliberately special" from "silently
 * forgotten": a new `workspace_id` table must be added to the list above or acknowledged here.
 *
 * `spend_days` is the one that is KEPT. It is the account's durable cost record, and money
 * already spent is an account-level fact that a board deletion does not undo: reclaiming it
 * would shrink last quarter's TCO retroactively, which is the exact failure the rollup exists
 * to prevent, and it would do so silently. Same reasoning that keeps `audit_events` out of the
 * cascade (a board being deleted is itself worth having a record of), differing only in that
 * this table lives in the main store, so it has to be named here rather than excluded by
 * living in another database. The frozen labels it carries (board name, block title, repo
 * name) therefore outlive the board.
 *
 * Naming it here is only half of keeping it, and the other half lives in
 * `SpendRollupRepository.rollupSpendDays`: the rollup REWRITES a trailing window by deleting
 * it and re-folding `token_usage`, which IS in the list above. A rewrite that deleted its
 * window unconditionally would therefore reclaim the deleted board's most recent days on the
 * sweep's own schedule, with no further operator action, and this exclusion would hold in name
 * only. The rewrite is bounded to workspaces that still exist for exactly that reason, so a
 * table added here has to answer the same question: what re-derives it, and can that
 * re-derivation still see the board?
 *
 * That bound leaves the mirror-image question, and the delete answers it rather than the sweep:
 * the board's spend since the last completed rollup day was never folded at all, and its ledger
 * rows are in the list above, so they would go before any pass could see them. `token_usage` is
 * therefore not simply cascaded here: `WorkspaceService.delete` runs one final per-workspace
 * fold (`SpendRollupRepository.rollupWorkspaceSpendDays`) BEFORE this cascade runs, so what the
 * table keeps of a deleted board ends where the board did.
 */
export const WORKSPACE_CASCADE_SPECIAL_TABLES = [
  'workspace_services',
  'binary_artifacts',
  'spend_days',
] as const

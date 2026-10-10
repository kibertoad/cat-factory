// Persistence port for the per-workspace SUPPRESSION of a deployment-registered custom task type
// (a reusable operation; see `backend/docs/reusable-operations.md`). The Worker implements it
// against D1, the Node service against Postgres; tests supply an in-memory fake.
//
// The store is a set of TOMBSTONES: a row means "this workspace does not offer this operation", and
// restoring hard-deletes it. There is no flag and nothing to seed, because absence has to be the
// default: a deployment registers its operations process-wide, so a newly registered one is
// offered on every board until an admin hides it. The other direction (a stored `visible` row per
// workspace per type) would withhold every new operation from every existing board until somebody
// noticed, which is the silent failure the "absent ≠ off" rule exists to prevent.
//
// The row names the task type by ID and carries nothing else. Presentation, fields and the pipeline
// pin all live in the registration, which is code; copying any of it here would go stale against a
// re-registration, and a suppressed id whose registration is later withdrawn is simply a row that
// matches nothing.

export interface TaskTypeSuppressionRepository {
  /**
   * Every task-type id this workspace suppresses. ONE query, read by the board snapshot (to filter
   * the projected catalog) and by the settings screen (to render what is hidden), never a point
   * read per registered type, which would be an N+1 over the whole catalog on every board load.
   */
  list(workspaceId: string): Promise<string[]>
  /** Suppress one task type. Idempotent: re-suppressing an already-hidden type is a no-op. */
  suppress(workspaceId: string, taskType: string, createdAt: number): Promise<void>
  /** Restore one task type by DELETING its tombstone. No-op when it was not suppressed. */
  restore(workspaceId: string, taskType: string): Promise<void>
}

// Persistence port for the pre-PR validation checks (see
// docs/initiatives/pre-pr-validation.md). Mirrors across the D1 (Cloudflare) and
// Drizzle/Postgres (Node) facades — runtime parity is mandatory. Nothing here is
// secret: the commands are operator-authored shell strings the harness runs in the
// run's own container.

/**
 * A service frame's pre-PR validation config: the ordered commands the harness runs
 * against the checkout before opening a PR, and the repair-round budget it runs them
 * under. Keyed by (workspace, block); a run resolves it by walking its block UP to the
 * service frame.
 */
export interface ValidationConfigRecord {
  workspaceId: string
  /** The SERVICE FRAME block these checks belong to. */
  blockId: string
  /** Ordered `{ label, command }` pairs, persisted as a JSON array. */
  checks: { label: string; command: string }[]
  /** How many agent+check rounds the harness may run (1 = check once, no repair round). */
  maxAttempts: number
  createdAt: number
  updatedAt: number
}

export interface ValidationConfigRepository {
  getByBlock(workspaceId: string, blockId: string): Promise<ValidationConfigRecord | null>
  listByWorkspace(workspaceId: string): Promise<ValidationConfigRecord[]>
  upsert(record: ValidationConfigRecord): Promise<void>
  delete(workspaceId: string, blockId: string): Promise<void>
}

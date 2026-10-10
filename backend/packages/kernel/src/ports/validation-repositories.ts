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
  /**
   * DEPENDENCY PREPOPULATION: the install the harness runs against the checkout BEFORE the
   * agent's first turn, so it reads a tree whose dependencies are present instead of inferring
   * them from a manifest. Shares this row because it is resolved by the same frame-chain read
   * the checks are, but it is a separate concern: a service may declare only this, or only
   * checks. Absent ⇒ no prepopulation (the pre-feature behaviour).
   */
  dependencyInstall?: string
  createdAt: number
  updatedAt: number
}

export interface ValidationConfigRepository {
  getByBlock(workspaceId: string, blockId: string): Promise<ValidationConfigRecord | null>
  listByWorkspace(workspaceId: string): Promise<ValidationConfigRecord[]>
  upsert(record: ValidationConfigRecord): Promise<void>
  delete(workspaceId: string, blockId: string): Promise<void>
}

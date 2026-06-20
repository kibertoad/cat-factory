// In-org shared services. Mirrors the `@cat-factory/contracts` `services` wire schemas:
// a `Service` is the account-owned unit of work (a service frame + its subtree + repo),
// shared across the workspaces that *mount* it; a `WorkspaceMount` places a service onto a
// workspace board with that board's own frame layout override.

export interface Service {
  id: string
  accountId: string | null
  frameBlockId: string
  installationId: number | null
  repoGithubId: number | null
  /** Subdirectory within the linked monorepo this service lives in (null = whole repo). */
  directory?: string | null
  createdAt: number
  /** How many boards mount this service. Set only on the org catalog (for the "Shared" badge). */
  mountCount?: number
}

export interface WorkspaceMount {
  workspaceId: string
  serviceId: string
  /** This board's frame position override. */
  position: { x: number; y: number }
  /** This board's dragged frame size; null/absent = auto-size. */
  size?: { w: number; h: number } | null
  createdAt: number
}

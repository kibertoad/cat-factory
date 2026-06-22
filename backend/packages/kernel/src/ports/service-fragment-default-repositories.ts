// Persistence port for a workspace's default service-fragment selection — the
// best-practice prompt fragment ids that new services inherit. The Cloudflare facade
// implements it against D1, the Node facade against Postgres; tests supply an
// in-memory fake. Stored as one list per workspace; empty when none set.

export interface ServiceFragmentDefaultsRepository {
  /** The workspace's default fragment ids (empty array when none set). */
  get(workspaceId: string): Promise<string[]>
  /** Replace the workspace's default fragment ids wholesale. */
  set(workspaceId: string, fragmentIds: string[]): Promise<void>
}

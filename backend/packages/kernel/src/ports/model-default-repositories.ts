// Persistence port for a workspace's per-agent-kind default model selection. The
// worker implements it against D1, the Node service against Postgres; tests supply
// an in-memory fake. The map is keyed by agent kind and valued by a model catalog
// id; a kind absent from the map falls back to the env routing for that kind.

export interface ModelDefaultsRepository {
  /** The whole per-kind default map for a workspace (`{ [agentKind]: modelId }`); empty when none set. */
  get(workspaceId: string): Promise<Record<string, string>>
  /** The model id chosen for a single agent kind, or null when the workspace pins none. */
  getForKind(workspaceId: string, agentKind: string): Promise<string | null>
  /** Replace the whole per-kind map for the workspace (a kind omitted is cleared). */
  replace(workspaceId: string, defaults: Record<string, string>): Promise<void>
}

import * as v from 'valibot'

/**
 * One directed service→service dependency edge, stored on the CONSUMER service
 * frame: "this service USES the target service". So "A (email sender) serves B"
 * is stored on B as `{ serviceBlockId: <A's frame block id> }`. Storing the edge
 * on exactly one endpoint keeps a single canonical record per relationship (no
 * dual-write, no conflicting duplicate descriptions), and the direction gives the
 * later merge/provision ordering a provider-before-consumer topology for free.
 * This is the backend↔backend sibling of a frontend frame's `backendBindings`
 * (see {@link frontendBackendBindingSchema}) — frontend frames keep that
 * mechanism; service connections link `type: 'service'` frames only.
 */
export const serviceConnectionSchema = v.object({
  /** The PROVIDER service frame's block id (a `level: 'frame'`, `type: 'service'` block). */
  serviceBlockId: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /**
   * How this service uses the provider, e.g. "sends transactional email via it".
   * Prose for humans on the board AND for agents: when the provider is involved in
   * a task, this line is folded into the agent's prompt to explain the relationship.
   */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(300))),
})
export type ServiceConnection = v.InferOutput<typeof serviceConnectionSchema>

/** A service frame's outgoing (consumer→provider) connections. */
export const serviceConnectionsSchema = v.pipe(v.array(serviceConnectionSchema), v.maxLength(50))

/**
 * The undirected connection-neighbor set of a service frame: the providers its own
 * `serviceConnections` name PLUS every frame whose connections name it. A task's
 * "involved services" are picked from this set regardless of edge direction — a
 * task on either endpoint of a connection may need the other spun up or changed.
 * Shared by the SPA (the involved-services selector) and BoardService (write-time
 * validation), like the other pure contracts helpers.
 */
export function connectionNeighborIds(
  blocks: ReadonlyArray<{ id: string; serviceConnections?: ServiceConnection[] }>,
  frameId: string,
): Set<string> {
  const neighbors = new Set<string>()
  for (const block of blocks) {
    for (const connection of block.serviceConnections ?? []) {
      if (block.id === frameId && connection.serviceBlockId !== frameId) {
        neighbors.add(connection.serviceBlockId)
      } else if (connection.serviceBlockId === frameId && block.id !== frameId) {
        neighbors.add(block.id)
      }
    }
  }
  return neighbors
}

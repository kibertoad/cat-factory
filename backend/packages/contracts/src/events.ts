import type { Block, ExecutionInstance } from './entities'

// Real-time events pushed from the per-workspace events hub to subscribed
// browsers over WebSocket, replacing the old `tick` polling. The shape is shared
// by the worker (which publishes) and the frontend (which applies them to its
// stores), so the wire contract lives here in @cat-factory/contracts.

export type WorkspaceEvent =
  /**
   * A run advanced. Carries the updated instance and its server-rolled block, so
   * the client patches both caches without a refetch. `block` is null only if the
   * block vanished between the transition and the publish.
   */
  | { type: 'execution'; instance: ExecutionInstance; block: Block | null; at: number }
  /**
   * A structural board change the per-instance event can't express (a module
   * materialised, a run cancelled). The client responds with a full refresh.
   */
  | { type: 'board'; reason: string; at: number }

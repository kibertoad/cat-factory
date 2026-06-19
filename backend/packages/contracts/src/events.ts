import type { Block, ExecutionInstance } from './entities.js'
import type { BootstrapJob } from './bootstrap.js'
import type { Notification } from './notifications.js'

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
  /**
   * A repo-bootstrap run advanced. Carries the updated job (with live `subtasks`)
   * and its provisional/linked service frame, so the client patches the board
   * card and its progress without a refetch. `block` is null only if the frame
   * vanished between the transition and the publish.
   */
  | { type: 'bootstrap'; job: BootstrapJob; block: Block | null; at: number }
  /**
   * A human-actionable notification was raised or resolved (a PR needs review, a
   * pipeline finished and wants confirmation, CI fixing gave up). The client
   * upserts it into its notifications store and surfaces/clears the board badge.
   */
  | { type: 'notification'; notification: Notification; at: number }

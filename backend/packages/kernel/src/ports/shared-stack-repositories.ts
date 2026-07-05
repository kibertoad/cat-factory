import type { SharedStack } from '../domain/types.js'

// Persistence port for a workspace's SHARED STACKS — long-lived compose infra a per-PR
// consumer environment attaches to over an external network (the acme-shared-services
// pilot). Both facades implement it (D1 ⇄ Drizzle, runtime parity is mandatory); tests
// supply an in-memory fake. A shared stack is NEVER swept with a run and never TTL-reaped
// — the row persists until the user deletes it. Its `status`/`lastError` are updated in
// place by the lifecycle service (via `upsert`) as it brings the stack up / tears it down.

export interface SharedStackRepository {
  /** A shared stack by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<SharedStack | null>
  /** All shared stacks for a workspace (for the snapshot + Infrastructure panel). */
  list(workspaceId: string): Promise<SharedStack[]>
  /** Create or replace a shared stack (keyed by id). */
  upsert(workspaceId: string, stack: SharedStack): Promise<void>
  /** Remove a shared stack by id (no-op if absent). */
  remove(workspaceId: string, id: string): Promise<void>
}

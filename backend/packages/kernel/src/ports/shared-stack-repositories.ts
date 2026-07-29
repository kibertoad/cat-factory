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

/**
 * Idempotently ensure a deployment's PRE-DECLARED shared stacks exist in a workspace — the
 * shared-stack sibling of {@link EnvironmentHandlerSeeder}, and the same two wiring sites: a boot
 * backfill over every existing workspace, plus `WorkspaceService.create`'s on-create hook.
 *
 * This is what makes a stack declarable in CODE rather than only through the SPA: a deployment
 * hands `startNode`/`startLocal` a list of stack definitions — compose layers supplied inline, or
 * read from another repo — and every board it owns comes up able to attach to them with no manual
 * step. Seeds are matched by NAME within the workspace (the id is generated per workspace), so a
 * second boot is a no-op and a re-created workspace re-seeds.
 */
export interface SharedStackSeeder {
  ensureForWorkspace(workspaceId: string): Promise<void>
}

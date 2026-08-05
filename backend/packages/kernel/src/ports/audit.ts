import type {
  AuditAction,
  AuditActorKind,
  AuditEventDetails,
  AuditTargetType,
  RetiredAuditValue,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The account audit log: an append-only record of WHO did WHAT, WHEN, for the privileged and
// destructive actions an account admin is answerable for.
//
// Two ports, because the writer and the store want opposite things. `AuditRecorder` is the
// narrow seam a domain service depends on: one method, never throws, so an audited service is
// unchanged in shape from an unaudited one and a service test needs no store.
// `AuditEventRepository` is the persistence port a facade implements. Keeping them apart is what
// lets the tenancy services in `@cat-factory/workspaces` audit themselves without depending on
// how (or whether) a deployment persists the result.
// ---------------------------------------------------------------------------

/** WHO performed an audited action. */
export type AuditActor =
  /** A signed-in user, by internal id (`usr_*`). */
  | { kind: Extract<AuditActorKind, 'user'>; userId: string }
  /**
   * A public-API key, by key id. Deliberately NOT the user who minted the key: attributing a
   * key's actions to that person would make a leaked key indistinguishable from them.
   */
  | { kind: Extract<AuditActorKind, 'apiKey'>; apiKeyId: string }
  /**
   * The engine, with no human in the loop. ASSERTED by an engine-internal caller, never a
   * fallback for an unresolved user: "the engine did it" and "we lost track of who did it" are
   * different facts, and a log that renders them identically misattributes a human action.
   */
  | { kind: Extract<AuditActorKind, 'system'> }

/**
 * One audited action, as its writer states it.
 *
 * **`details` carries no secret material and no PROSE.** The values are machine-readable fields
 * the viewer interpolates into translated copy (`AUDIT_ACTION_DETAIL_KEYS` in contracts names
 * them per action), which is what lets a row written today be read in another locale years
 * later. A credential-shaped event records the provider and the key NAME; never the value, never
 * a decrypted blob, never model or prompt text.
 */
export interface AuditEvent {
  /** The account the action belongs to; the only scope the viewer reads by. */
  accountId: string
  /** The workspace it happened in, when the action is board-scoped. */
  workspaceId?: string | null
  actor: AuditActor
  action: AuditAction
  /** What kind of thing was acted ON; `targetId` is an id within it. */
  targetType: AuditTargetType
  /** Id of the thing acted on, within `targetType`. */
  targetId: string
  /**
   * What changed, as fields: `{ previousRole: 'viewer', role: 'admin' }`. Keyed by action in
   * `AUDIT_ACTION_DETAIL_KEYS`, so the writer and the viewer agree about the slots rather than
   * each deciding. Values safe to show only (a role set, a budget ceiling, an email).
   */
  details: AuditEventDetails
}

/**
 * An audit event as WRITTEN: an {@link AuditEvent} plus what the store assigned it.
 *
 * The vocabularies are still CLOSED here, which is the point of separating this from
 * {@link AuditEventView}: nothing can append a value the build does not declare, while a read
 * must cope with one a past build did.
 */
export interface AuditEventRecord extends AuditEvent {
  /** Store-assigned id (`aud_*`). */
  id: string
  /** Epoch ms the action committed. */
  at: number
}

/**
 * An audit event as READ BACK, for a viewer to render.
 *
 * `action` and `targetType` widen to `| RetiredAuditValue` because both are closed vocabularies
 * that are also persisted: a member retired from the type goes on existing in rows written
 * before it was. Widening HERE is what forces every reader to say what it renders for one,
 * instead of dropping the row or interpolating `undefined` (see `RetiredAuditValue` in
 * contracts).
 */
export interface AuditEventView extends Omit<AuditEventRecord, 'action' | 'targetType'> {
  action: AuditAction | RetiredAuditValue
  targetType: AuditTargetType | RetiredAuditValue
}

/** One page of audit events, newest first. */
export interface AuditEventPage {
  events: AuditEventView[]
  /**
   * Cursor for the next (older) page, or null at the end. Opaque to the caller: a facade may
   * change its encoding freely, and nothing but the same repository ever reads it.
   */
  nextCursor: string | null
}

/**
 * Persistence for the append-only audit log.
 *
 * **Append-only means append-only**: there is no update and no delete here. The retention
 * sweep is a later slice and will add its own method; until then, nothing in the platform can
 * rewrite or remove a recorded event, which is the property that makes the log worth reading.
 *
 * Reads are PAGINATED from the start. An audit table only grows, so the unbounded `SELECT`
 * that is merely untidy on a young deployment is the one that times out on the deployment
 * that has been running long enough to have something worth auditing.
 */
export interface AuditEventRepository {
  /** Append one event. */
  append(event: AuditEventRecord): Promise<void>
  /**
   * One page of an account's events, newest first. `cursor` continues a previous page;
   * absent starts at the newest. `limit` bounds the page.
   */
  listByAccount(
    accountId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<AuditEventPage>
}

/**
 * The write seam a domain service depends on: state that something audit-worthy happened.
 *
 * `record` MUST NOT throw or reject. An audit write is a best-effort side channel: a store
 * outage must cost the audit row, never the membership change the operator asked for. That
 * swallow is the implementation's job (it logs through the kernel `Logger`, so a permanently
 * broken audit store surfaces as warnings rather than as silence), which is why the port gives a
 * service nothing to handle and no reason to wrap the call.
 *
 * It is AWAITED rather than fire-and-forget, and that is a correctness requirement, not a style
 * choice: on the Worker an un-awaited write is dropped when the isolate is frozen after the
 * response (the rule `@cat-factory/server`'s `http/waitUntil.ts` exists to state), so a
 * fire-and-forget append would record nothing on the primary runtime while every test that
 * drives a fake recorder still passed. A store round-trip is worth strictly more than the
 * milliseconds it costs an admin action, because "nobody changed anything" is the exact
 * assurance this log exists to give.
 */
export interface AuditRecorder {
  record(event: AuditEvent): Promise<void>
}

/**
 * The no-op recorder, for a deployment or a test with no audit store wired.
 *
 * Named rather than an inline `{ record: async () => {} }` at each site, for the same reason
 * `noopLogger` and `noopOperationalMetrics` are: a caller that audits nothing should have to
 * SAY so in code, so "this deployment does not persist audit events" and "somebody forgot to
 * wire the store" stop looking identical at the construction site.
 */
export const noopAuditRecorder: AuditRecorder = { record: () => Promise.resolve() }

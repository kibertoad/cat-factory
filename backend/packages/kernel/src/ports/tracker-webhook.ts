import type { TaskSourceKind } from '../domain/types.js'
import type { TaskCredentials } from './task-source.js'

// Inbound tracker webhook deliveries: the PUSH counterpart of the polling task-source reads.
//
// An issue enters the platform today only when a recurring `bug-intake` schedule fires or a
// human imports it, so intake latency is the schedule interval and every idle poll costs a
// tracker API call. This port is the seam that lets a tracker tell us instead. It mirrors the
// VCS webhook layering exactly: the shared receiver owns the transport (raw body, ack fast,
// hand off to the facade's queue) and a PROVIDER owns everything vendor-specific — how the
// delivery is signed and how its payload maps onto a neutral event.
//
// A provider without the capability simply never receives deliveries; the receiver 404s such a
// source so an operator who pasted the wrong URL learns immediately instead of into a void.
//
// See docs/initiatives/tracker-webhook-intake.md.

/** A raw inbound delivery, before any parsing. */
export interface TrackerWebhookDelivery {
  /**
   * The vendor's event-name header (`x-github-event`, `x-atlassian-webhook-identifier`,
   * Linear's `linear-event`), or `''` when the vendor sends none. Providers that key off the
   * payload instead may ignore it.
   */
  eventName: string
  /** Every request header, with LOWER-CASED keys (Hono's `c.req.header()` shape). */
  headers: Record<string, string>
  /**
   * The request bytes exactly as received. Verification runs over THESE — never over a
   * re-serialised parse, which is a classic signature bypass.
   */
  raw: ArrayBuffer
}

/** Who wrote a tracker comment, as much as the vendor tells us. */
export interface TrackerCommentAuthor {
  /** The vendor's stable user id (GitHub node id, Jira `accountId`, Linear user id); null if absent. */
  id: string | null
  /** The display handle / login the human would recognise (GitHub login, Jira/Linear display name). */
  handle: string | null
  /** The author's email where the vendor exposes it (Jira/Linear); null on GitHub. */
  email: string | null
  /**
   * Whether the vendor marked the author as a bot / app. Load-bearing: the platform's OWN
   * writeback comments come back as deliveries, so a bot author is dropped before any parsing —
   * otherwise the follow-up comment feeds itself.
   */
  bot: boolean
}

/** An issue was created or changed on the tracker. */
export interface TrackerIssueEvent {
  kind: 'issue'
  source: TaskSourceKind
  /** The source's canonical key for the issue — half of the task projection's natural key. */
  externalId: string
  /** Coarse lifecycle action; `updated` covers label/type/field edits and reopen. */
  action: 'created' | 'updated' | 'closed'
  title: string
  labels: string[]
  /** Issue type name where the vendor has one (Jira issue type / GitHub issue type); else null. */
  issueType: string | null
  /** Canonical web URL, when the payload carries one. */
  url: string | null
}

/** A comment was added to an issue on the tracker. */
export interface TrackerCommentEvent {
  kind: 'comment'
  source: TaskSourceKind
  /** The issue the comment is on. */
  externalId: string
  /** The vendor's comment id — the ingest claim's dedup key, so a redelivery applies once. */
  commentId: string
  /** The comment body, as the vendor sent it (normalisation/capping happens at ingest). */
  body: string
  author: TrackerCommentAuthor
}

/** The neutral shape every provider maps its deliveries onto. */
export type TrackerWebhookEvent = TrackerIssueEvent | TrackerCommentEvent

/**
 * A task source's inbound-webhook capability. Optional on {@link TaskSourceProvider}: a source
 * that cannot push (or whose push we don't support yet) simply omits it.
 */
export interface TaskSourceWebhookAdapter {
  /**
   * Verify a delivery against the workspace connection's stored webhook secret, over the RAW
   * bytes. MUST return false — never throw — for a missing, malformed or mismatched signature,
   * and MUST fail closed when `secret` is empty (an empty HMAC key lets an attacker forge a
   * signature over their own body).
   */
  verify(secret: string, delivery: TrackerWebhookDelivery): Promise<boolean>
  /**
   * Map a VERIFIED delivery onto the neutral event, or null when it is a delivery kind this
   * integration does not act on (a project update, a sprint change, a vendor ping). A null is
   * acked, not an error — trackers send far more event kinds than we consume.
   */
  parse(delivery: TrackerWebhookDelivery): TrackerWebhookEvent | null
}

/**
 * The credential-bag key a connection's inbound webhook secret is stored under.
 *
 * It rides the existing sealed `credentials` bag rather than a new column: the bag is already
 * encrypted at rest, already per `(workspace, source)`, and already the thing a provider is
 * handed — so the secret needs no table, no migration and no second lifecycle. Providers MUST
 * NOT treat it as a vendor credential (it is never sent to the vendor), which is why
 * `normalizeConnection` implementations preserve it rather than reading it.
 */
export const TRACKER_WEBHOOK_SECRET_KEY = 'webhookSecret'

/**
 * The credential-bag key holding the reply-identity allow-list: a comma-separated list of
 * author handles / emails / vendor ids permitted to drive a parked review from a ticket
 * comment. Empty or absent ⇒ any NON-BOT author is allowed, which is the right default for a
 * private tracker and the wrong one for a public repo — hence the knob.
 */
export const TRACKER_WEBHOOK_REPLY_ALLOW_KEY = 'webhookReplyAllow'

/** Read the inbound webhook secret out of a connection's credential bag (`''` when unset). */
export function trackerWebhookSecret(credentials: TaskCredentials | undefined): string {
  return credentials?.[TRACKER_WEBHOOK_SECRET_KEY]?.trim() ?? ''
}

/**
 * Every task source this build knows about — the runtime companion of the closed
 * `taskSourceKindSchema` union, so the webhook receiver can reject an unknown `:source` path
 * segment before touching the container.
 *
 * Kept in step with `@cat-factory/contracts`' `taskSourceKindSchema` by the `TaskSourceKind` type
 * annotation: adding a member there without adding it here fails the typecheck at the
 * `readonly TaskSourceKind[]` position. Widening the union for deployment-registered trackers is a
 * deliberate follow-up (slice 4 of `docs/initiatives/tracker-webhook-intake.md`).
 */
export const TASK_SOURCE_KINDS: readonly TaskSourceKind[] = ['jira', 'github', 'linear'] as const

/** Type guard: is `value` one of the known {@link TaskSourceKind}s? */
export function isTaskSourceKind(value: unknown): value is TaskSourceKind {
  return typeof value === 'string' && (TASK_SOURCE_KINDS as readonly string[]).includes(value)
}

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
// See backend/docs/adr/0032-tracker-webhook-intake.md.

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
  /**
   * The vendor board this issue sits on, in exactly the shape the matching
   * `IssueIntakeQuery.board` field carries: a Jira project key, an `owner/repo` slug, a Linear
   * team id, or a registered source's opaque board id. So a schedule's configured scope can be
   * compared against it without any per-source knowledge here.
   *
   * `null` means the DELIVERY did not say, never "no board". The distinction is load-bearing:
   * an intake schedule is scoped to one board, so a null is a predicate the event cannot answer
   * rather than one it fails, and the two dispatch modes dispose of that differently (see
   * `intakeMatch.logic.ts`). All three built-in adapters populate it from the payload they
   * already parse, so a null here is a vendor shape we did not recognise.
   */
  board: string | null
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
 * The task-source vocabulary, re-exported from `@cat-factory/contracts` (which owns the schema)
 * rather than re-listed here, because a second copy of a vocabulary is a second thing to forget.
 *
 * `BUILTIN_TASK_SOURCE_KINDS` is no longer "every source that can exist": a deployment registers
 * its own on the app-owned `TaskSourceRegistry` (D7 of
 * `backend/docs/adr/0032-tracker-webhook-intake.md`), and those never appear in it. Anything
 * deciding what a deployment ACTUALLY serves must ask the registry; the constant answers only "did
 * we ship it", and {@link isTaskSourceKind} answers only "is this a well-formed id".
 */
export { BUILTIN_TASK_SOURCE_KINDS, isTaskSourceKind } from '@cat-factory/contracts'
export type { BuiltinTaskSourceKind } from '@cat-factory/contracts'

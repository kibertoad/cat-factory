import type {
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
} from '../domain/types.js'
import type { VcsConnectionRef, VcsRepoRef } from '../domain/vcs-types.js'

// ---------------------------------------------------------------------------
// Provider-neutral webhook ingest.
//
// Each VCS host signs and shapes its webhook deliveries differently (GitHub HMAC
// `X-Hub-Signature-256` + `pull_request`/`check_run` events; GitLab `X-Gitlab-Token`
// + `Merge Request Hook`/`Pipeline Hook` events). A per-provider {@link VcsWebhookMapper}
// turns a verified raw delivery into one of these neutral {@link VcsWebhookEvent}s, so the
// shared `WebhookService` projects off `event.kind` rather than provider-specific event
// strings + payload shapes. A delivery the mapper doesn't recognise maps to `null` (the
// service ignores it) or to a `repo-resync` event (fall back to the pull side).
// ---------------------------------------------------------------------------

/** A normalised inbound webhook event, ready for the shared projector to apply. */
export type VcsWebhookEvent =
  | {
      kind: 'pull-request'
      connection: VcsConnectionRef
      repo: VcsRepoRef
      pullRequest: GitHubPullRequest
    }
  | {
      kind: 'issue'
      connection: VcsConnectionRef
      repo: VcsRepoRef
      issue: GitHubIssue
    }
  | {
      kind: 'push'
      connection: VcsConnectionRef
      repo: VcsRepoRef
      /** The pushed branch head, when the push targeted a branch. */
      branch?: { name: string; headSha: string }
      commits: GitHubCommit[]
    }
  | {
      kind: 'ci-status'
      connection: VcsConnectionRef
      repo: VcsRepoRef
      checkRun: GitHubCheckRun
    }
  | {
      /** A connection-wide lifecycle change (install removed/suspended/revived). */
      kind: 'connection-lifecycle'
      connection: VcsConnectionRef
      action: 'removed' | 'suspended' | 'revived'
      /** Repo ids that became inaccessible (to tombstone), when the host reports them. */
      removedRepoIds?: string[]
    }
  | {
      /** Heavy/ambiguous delivery: ask the pull side to resync the repo. */
      kind: 'repo-resync'
      connection: VcsConnectionRef
      repo: VcsRepoRef
    }

/** The raw, already-signature-verified delivery handed to a {@link VcsWebhookMapper}. */
export interface RawWebhookDelivery {
  /** The provider's event-name header (`X-GitHub-Event` / `X-Gitlab-Event`). */
  eventName: string
  /** The parsed JSON payload. */
  payload: unknown
  /** All request headers, lower-cased, for providers that key off more than the event name. */
  headers?: Record<string, string>
}

/**
 * Normalise a raw webhook delivery into a neutral {@link VcsWebhookEvent}, or `null` when
 * the delivery carries nothing to project. Provider-specific; one per adapter.
 *
 * The `connection` is resolved by the receiver BEFORE mapping (GitHub derives it from the
 * payload's `installation.id`; GitLab from the project/secret → connection lookup), so the
 * mapper only stamps it onto the event rather than having to discover it from the payload.
 */
export interface VcsWebhookMapper {
  map(connection: VcsConnectionRef, delivery: RawWebhookDelivery): VcsWebhookEvent | null
}

/**
 * Consumer of a normalised {@link VcsWebhookEvent}, wired by a facade. The neutral webhook
 * ingest route verifies + maps a delivery and hands the result here. Optional: when no sink
 * is wired the route still verifies + maps (acks fast) but drops the event — projecting a
 * neutral event into a provider's projection tables is the follow-up that generalises the
 * GitHub-keyed `github_*` persistence onto the neutral identity.
 */
export interface VcsWebhookSink {
  handle(event: VcsWebhookEvent): Promise<void>
}

import type { SubscriptionVendor } from '@cat-factory/contracts'

/**
 * What a deep guided-review answer runs in: a read-only container with a checkout of the PR,
 * dispatched once per question and polled until it reports. Implemented by the server's
 * `ContainerGuidedReviewInvestigator`; absent on a deployment with no runner, where a deep
 * question settles as `depth_unavailable`.
 */
export interface GuidedReviewInvestigator {
  /** Whether this workspace's runner backend can serve an investigation at all. */
  supports(workspaceId: string): Promise<boolean>
  /** Dispatch the container. Idempotent per `jobId`, so a replayed start addresses the same job. */
  start(request: GuidedReviewInvestigationRequest): Promise<GuidedReviewInvestigationHandle>
  poll(handle: GuidedReviewInvestigationHandle): Promise<GuidedReviewInvestigationUpdate>
  /** Best-effort reclaim; releasing a job that is gone is a no-op. */
  stop(handle: GuidedReviewInvestigationHandle): Promise<void>
}

export interface GuidedReviewInvestigationRequest {
  workspaceId: string
  /** The assistant message being answered; it is the job's id and its spend's run id. */
  jobId: string
  /** The session creator, whose model scope and credentials the job runs on. */
  initiatedBy: string
  repo: { owner: string; name: string; provider?: 'github' | 'gitlab' }
  prNumber: number
  baseRef: string
  headSha: string
  /** The rendered thread, ending in the question to answer. */
  userPrompt: string
}

/**
 * What only the dispatch knows, persisted by the caller and handed back on every poll: the model
 * the job runs and the credential it leased, which a later poll must not re-resolve.
 */
export interface GuidedReviewInvestigationDispatch {
  model: string
  subscriptionTokenId?: string
  subscriptionVendor?: SubscriptionVendor
}

export interface GuidedReviewInvestigationHandle {
  workspaceId: string
  jobId: string
  initiatedBy: string
  dispatch: GuidedReviewInvestigationDispatch
}

export type GuidedReviewInvestigationUpdate =
  | { state: 'running' }
  /** `report` is the job's raw structured output; the caller coerces it. */
  | { state: 'done'; report: unknown; model: string }
  | { state: 'failed'; error: string }

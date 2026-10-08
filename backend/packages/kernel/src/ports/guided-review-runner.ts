/**
 * One unit of guided-review background work: generating a session's overview, or producing one
 * assistant message (an answer or a set of comment drafts). The persisted row is authoritative;
 * a job only says which row to drive.
 */
export type GuidedReviewJob =
  | { kind: 'overview'; sessionId: string; generation: number }
  | { kind: 'message'; messageId: string }

/** The stable key of a job: what a queue deduplicates live entries on. */
export function guidedReviewJobKey(job: GuidedReviewJob): string {
  return job.kind === 'overview' ? `gro-${job.sessionId}-${job.generation}` : `grm-${job.messageId}`
}

/**
 * Drives guided-review jobs durably outside the request that queued them (Cloudflare Workflows,
 * pg-boss, or a mothership-mode node's `node:sqlite` queue). `start` may deliver a job more than
 * once; `GuidedReviewService.runJob` claims the row before any model call, so a duplicate is a
 * no-op rather than a second answer.
 */
export interface GuidedReviewRunner {
  start(workspaceId: string, job: GuidedReviewJob): Promise<void>
}

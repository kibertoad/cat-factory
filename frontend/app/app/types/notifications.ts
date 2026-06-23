// Notification shapes, mirroring `@cat-factory/contracts` (notifications.ts). A
// notification is a first-class, human-actionable item surfaced on the board that
// outlives the run that raised it (a PR awaiting a merge decision, a completed
// pipeline awaiting confirmation, CI that gave up).

import type { MergeAssessment } from './merge'

export type NotificationType =
  | 'merge_review'
  | 'pipeline_complete'
  | 'ci_failed'
  | 'test_failed'
  | 'requirement_review'
  | 'clarity_review'
  | 'release_regression'
  | 'decision_required'
export type NotificationStatus = 'open' | 'acted' | 'dismissed'

/** The on-call agent's recommendation on a `release_regression`. */
export type OnCallRecommendation = 'revert' | 'hold' | 'monitor'

/** The on-call agent's assessment of a post-release regression. */
export interface OnCallAssessment {
  culpritConfidence: number
  recommendation: OnCallRecommendation
  rationale: string
  evidence?: string[]
}

/** A regressed monitor/SLO on a `release_regression`. */
export interface ReleaseSignal {
  kind: 'monitor' | 'slo'
  id: string
  name: string
  state: 'ok' | 'warn' | 'alert' | 'no_data'
  detail?: string
}

/** Optional structured detail for rendering a notification card. */
export interface NotificationPayload {
  assessment?: MergeAssessment
  prUrl?: string
  pipelineName?: string
  findingCount?: number
  /** The on-call assessment, on a `release_regression`. */
  onCallAssessment?: OnCallAssessment
  /** The regressed monitors/SLOs, on a `release_regression`. */
  releaseSignals?: ReleaseSignal[]
  /** A proposed revert PR URL, when known. */
  revertUrl?: string
}

/** A human-actionable item surfaced on the board. */
export interface Notification {
  id: string
  type: NotificationType
  status: NotificationStatus
  blockId: string | null
  executionId: string | null
  title: string
  body: string
  payload?: NotificationPayload | null
  createdAt: number
  resolvedAt: number | null
}

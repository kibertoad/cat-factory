// Notification shapes, mirroring `@cat-factory/contracts` (notifications.ts). A
// notification is a first-class, human-actionable item surfaced on the board that
// outlives the run that raised it (a PR awaiting a merge decision, a completed
// pipeline awaiting confirmation, CI that gave up).

import type { MergeAssessment } from './merge'

export type NotificationType =
  | 'merge_review'
  | 'pipeline_complete'
  | 'ci_failed'
  | 'requirement_review'
export type NotificationStatus = 'open' | 'acted' | 'dismissed'

/** Optional structured detail for rendering a notification card. */
export interface NotificationPayload {
  assessment?: MergeAssessment
  prUrl?: string
  pipelineName?: string
  findingCount?: number
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

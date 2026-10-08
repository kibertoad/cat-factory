import type {
  GuidedReviewCommentDraft,
  GuidedReviewMessage,
  GuidedReviewSession,
  GuidedReviewThread,
} from '@cat-factory/contracts'
import {
  guidedReviewDepthSchema,
  guidedReviewDiffSideSchema,
  guidedReviewDraftReportSchema,
  guidedReviewDraftStatusSchema,
  guidedReviewFailureSchema,
  guidedReviewMessageKindSchema,
  guidedReviewMessageSchema,
  guidedReviewOverviewContentSchema,
  guidedReviewWorkStatusSchema,
  subscriptionVendorSchema,
  vcsProviderSchema,
} from '@cat-factory/contracts'
import type { GuidedReviewInvestigationRecord } from '@cat-factory/kernel'
import * as v from 'valibot'
import { decodeEnum, decodeJson } from './decode.js'

// Row mappers for the guided-review tables (D1 migration 0104 and its Drizzle mirror). Both
// facades read the same snake_case columns, so the decode lives here once.

export interface GuidedReviewSessionRow {
  id: string
  provider: string
  repo_id: string
  owner: string
  repo: string
  pr_number: number
  pr_title: string
  reviewed_head_sha: string
  base_ref: string
  created_by: string
  overview_status: string
  overview_generation: number
  overview_content: string | null
  overview_failure: string | null
  overview_model: string | null
  created_at: number
  updated_at: number
}

export interface GuidedReviewThreadRow {
  id: string
  session_id: string
  title: string
  created_by: string
  created_at: number
  updated_at: number
}

export interface GuidedReviewMessageRow {
  id: string
  thread_id: string
  session_id: string
  seq: number
  role: string
  kind: string
  depth: string
  content: string
  status: string
  citations: string
  failure: string | null
  draft_report: string | null
  model: string | null
  created_at: number
  updated_at: number
}

export interface GuidedReviewDraftRow {
  id: string
  session_id: string
  thread_id: string
  message_id: string
  path: string
  line: number
  start_line: number | null
  side: string
  body: string
  rationale: string
  status: string
  post_error: string | null
  posted_url: string | null
  rev: number
  created_at: number
  updated_at: number
}

export function rowToGuidedReviewSession(row: GuidedReviewSessionRow): GuidedReviewSession {
  const ctx = { table: 'guided_review_sessions', id: row.id }
  return {
    id: row.id,
    provider: decodeEnum(vcsProviderSchema, row.provider, { ...ctx, column: 'provider' }),
    repoId: row.repo_id,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    reviewedHeadSha: row.reviewed_head_sha,
    baseRef: row.base_ref,
    createdBy: row.created_by,
    overview: {
      status: decodeEnum(guidedReviewWorkStatusSchema, row.overview_status, {
        ...ctx,
        column: 'overview_status',
      }),
      generation: row.overview_generation,
      content:
        row.overview_content === null
          ? null
          : decodeJson(guidedReviewOverviewContentSchema, row.overview_content, {
              ...ctx,
              column: 'overview_content',
            }),
      failure:
        row.overview_failure === null
          ? null
          : decodeJson(guidedReviewFailureSchema, row.overview_failure, {
              ...ctx,
              column: 'overview_failure',
            }),
      model: row.overview_model,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function rowToGuidedReviewThread(row: GuidedReviewThreadRow): GuidedReviewThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function rowToGuidedReviewMessage(row: GuidedReviewMessageRow): GuidedReviewMessage {
  const ctx = { table: 'guided_review_messages', id: row.id }
  return {
    id: row.id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    seq: row.seq,
    role: decodeEnum(guidedReviewMessageSchema.entries.role, row.role, { ...ctx, column: 'role' }),
    kind: decodeEnum(guidedReviewMessageKindSchema, row.kind, { ...ctx, column: 'kind' }),
    depth: decodeEnum(guidedReviewDepthSchema, row.depth, { ...ctx, column: 'depth' }),
    content: row.content,
    status: decodeEnum(guidedReviewWorkStatusSchema, row.status, { ...ctx, column: 'status' }),
    citations: decodeJson(guidedReviewMessageSchema.entries.citations, row.citations, {
      ...ctx,
      column: 'citations',
    }),
    failure:
      row.failure === null
        ? null
        : decodeJson(guidedReviewFailureSchema, row.failure, { ...ctx, column: 'failure' }),
    draftReport:
      row.draft_report === null
        ? null
        : decodeJson(guidedReviewDraftReportSchema, row.draft_report, {
            ...ctx,
            column: 'draft_report',
          }),
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function rowToGuidedReviewDraft(row: GuidedReviewDraftRow): GuidedReviewCommentDraft {
  const ctx = { table: 'guided_review_comment_drafts', id: row.id }
  return {
    id: row.id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: decodeEnum(guidedReviewDiffSideSchema, row.side, { ...ctx, column: 'side' }),
    body: row.body,
    rationale: row.rationale,
    status: decodeEnum(guidedReviewDraftStatusSchema, row.status, { ...ctx, column: 'status' }),
    postError: row.post_error,
    postedUrl: row.posted_url,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const guidedReviewInvestigationSchema = v.object({
  dispatchedAt: v.number(),
  dispatch: v.object({
    model: v.string(),
    subscriptionTokenId: v.optional(v.string()),
    subscriptionVendor: v.optional(subscriptionVendorSchema),
  }),
})

/** A deep answer's recorded container dispatch, or null when none was recorded. */
export function decodeGuidedReviewInvestigation(
  raw: string | null,
  messageId: string,
): GuidedReviewInvestigationRecord | null {
  if (raw === null) return null
  return decodeJson(guidedReviewInvestigationSchema, raw, {
    table: 'guided_review_messages',
    column: 'investigation',
    id: messageId,
  })
}

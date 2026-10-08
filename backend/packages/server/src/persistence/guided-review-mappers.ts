import type {
  GuidedReviewCommentDraft,
  GuidedReviewMessage,
  GuidedReviewSession,
  GuidedReviewThread,
} from '@cat-factory/contracts'
import {
  guidedReviewCommentDraftSchema,
  guidedReviewDepthSchema,
  guidedReviewDiffSideSchema,
  guidedReviewDraftReportSchema,
  guidedReviewDraftStatusSchema,
  guidedReviewFailureSchema,
  guidedReviewMessageKindSchema,
  guidedReviewMessageSchema,
  guidedReviewOverviewContentSchema,
  guidedReviewWorkStatusSchema,
  vcsProviderSchema,
} from '@cat-factory/contracts'
import type {
  GuidedReviewDraftEdit,
  GuidedReviewDraftProposal,
  GuidedReviewMessageOutcome,
  GuidedReviewOverviewOutcome,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import * as v from 'valibot'
import { decodeEnum, decodeJson } from './decode.js'

// Row mappers for the guided-review tables (D1 migration 0104 and its Drizzle mirror). Both
// facades read and write the same snake_case columns, so the decode and the encode live here once.
// Every read decodes against the contracts schemas, so every write is checked against them first:
// an out-of-contract value is refused at its writer instead of making the row unreadable.

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

function check<T>(schema: v.GenericSchema<unknown, T>, value: unknown, what: string): T {
  const result = v.safeParse(schema, value)
  if (result.success) return result.output
  const issues = result.issues.map((i) => `${v.getDotPath(i) ?? '(root)'}: ${i.message}`)
  throw new ValidationError(`Guided review ${what} is out of contract: ${issues.join('; ')}`, {
    issues,
  })
}

const draftFieldsSchema = v.pick(guidedReviewCommentDraftSchema, [
  'id',
  'path',
  'line',
  'startLine',
  'side',
  'body',
  'rationale',
])
const messageEntries = guidedReviewMessageSchema.entries

/** The overview columns a settle writes, checked against the schema every read decodes with. */
export function encodeGuidedReviewOverviewOutcome(outcome: GuidedReviewOverviewOutcome): {
  content: string | null
  failure: string | null
} {
  if (outcome.status === 'complete') {
    const content = check(guidedReviewOverviewContentSchema, outcome.content, 'overview content')
    return { content: JSON.stringify(content), failure: null }
  }
  const failure = check(guidedReviewFailureSchema, outcome.failure, 'overview failure')
  return { content: null, failure: JSON.stringify(failure) }
}

/** The assistant-message columns a settle writes, checked like the overview's. */
export function encodeGuidedReviewMessageOutcome(outcome: GuidedReviewMessageOutcome): {
  content: string
  citations: string
  failure: string | null
  draftReport: string | null
} {
  if (outcome.status === 'failed') {
    const failure = check(guidedReviewFailureSchema, outcome.failure, 'message failure')
    return { content: '', citations: '[]', failure: JSON.stringify(failure), draftReport: null }
  }
  const content = check(messageEntries.content, outcome.content, 'message content')
  const citations = check(messageEntries.citations, outcome.citations, 'message citations')
  const report =
    outcome.draftReport === null
      ? null
      : check(guidedReviewDraftReportSchema, outcome.draftReport, 'draft report')
  return {
    content,
    citations: JSON.stringify(citations),
    failure: null,
    draftReport: report === null ? null : JSON.stringify(report),
  }
}

/** Refuse draft fields (a new proposal, or a draft with an edit applied) no read could decode. */
export function checkGuidedReviewDraftFields(draft: GuidedReviewDraftProposal): void {
  check(draftFieldsSchema, draft, `draft ${draft.id}`)
}

/**
 * `current` with a human edit applied, refused when the result is out of contract. Both stores
 * write exactly these fields under their rev guard.
 */
export function applyGuidedReviewDraftEdit(
  current: GuidedReviewCommentDraft,
  edit: GuidedReviewDraftEdit,
): GuidedReviewCommentDraft {
  const next: GuidedReviewCommentDraft = {
    ...current,
    path: edit.path ?? current.path,
    line: edit.line ?? current.line,
    startLine: edit.startLine === undefined ? current.startLine : edit.startLine,
    side: edit.side ?? current.side,
    body: edit.body ?? current.body,
    status: edit.discard ? 'discarded' : current.status,
    postError: edit.discard ? null : current.postError,
  }
  checkGuidedReviewDraftFields(next)
  return next
}

import {
  GUIDED_REVIEW_ANSWER_MAX,
  GUIDED_REVIEW_COMMENT_MAX,
  GUIDED_REVIEW_LIST_MAX,
  GUIDED_REVIEW_PROSE_MAX,
  GUIDED_REVIEW_TITLE_MAX,
  parseGuidedReviewAnchor,
  parseGuidedReviewOverviewContent,
  type GuidedReviewAnchor,
  type GuidedReviewDiffSide,
  type GuidedReviewDraftReport,
  type GuidedReviewMessage,
  type GuidedReviewOverviewContent,
  type GuidedReviewRiskSeverity,
} from '@cat-factory/contracts'
import type { GuidedReviewTurn } from '@cat-factory/agents'
import type { GitHubChangedFile } from '@cat-factory/kernel'
import { redactSecrets } from '@cat-factory/kernel'
import { computeCommentableLines } from '../execution/prReview.logic.js'

/** How long a claimed job may run before another driver may take it over. */
export const GUIDED_REVIEW_LEASE_MS = 10 * 60_000

/** One model loop ends inside the lease, so a sweeper never takes over a live generation. */
export const GUIDED_REVIEW_GENERATION_TIMEOUT_MS = GUIDED_REVIEW_LEASE_MS - 2 * 60_000

/** Prompt budgets: how much PR material and thread history one call is handed up front. */
export const OVERVIEW_INLINE_PATCH_CHARS = 60_000
export const THREAD_HISTORY_CHARS = 40_000

/** Model-loop bounds per job kind. The final step forbids tools so the loop ends on a reply. */
export const GUIDED_REVIEW_MAX_STEPS = { overview: 24, answer: 16, drafts: 16 } as const

const LIST_MAX = GUIDED_REVIEW_LIST_MAX
const PROSE_MAX = GUIDED_REVIEW_PROSE_MAX

/** A proposal the drafting model returned, before anchoring. */
export interface DraftProposal {
  path: string
  line: number
  startLine: number | null
  side: GuidedReviewDiffSide
  body: string
  rationale: string
}

/** Split the changed files' patches into the ones inlined in a prompt and the ones left out. */
export function partitionPatches(
  files: GitHubChangedFile[],
  budgetChars: number,
): { inline: { path: string; patch: string }[]; omitted: string[] } {
  const inline: { path: string; patch: string }[] = []
  const omitted: string[] = []
  let spent = 0
  for (const file of files) {
    if (file.patch === null) continue
    const patch = redactSecrets(file.patch) ?? ''
    if (spent + patch.length > budgetChars) {
      omitted.push(file.path)
      continue
    }
    spent += patch.length
    inline.push({ path: file.path, patch })
  }
  return { inline, omitted }
}

/**
 * The thread as the model is shown it: settled messages only, newest kept when the budget binds.
 * A failed or still-pending assistant message is left out, since it holds no answer.
 */
export function threadHistory(
  messages: GuidedReviewMessage[],
  budgetChars: number,
): { history: GuidedReviewTurn[]; omittedTurns: number } {
  const turns = messages
    .filter((m) => m.status === 'complete' && (m.role === 'user' || m.content.length > 0))
    .map((m) => ({ role: m.role, content: m.content }))
  const kept: GuidedReviewTurn[] = []
  let spent = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (kept.length > 0 && spent + turn.content.length > budgetChars) break
    spent += turn.content.length
    kept.unshift(turn)
  }
  return { history: kept, omittedTurns: turns.length - kept.length }
}

/** A thread title from its first question: the first line, cut to the title limit. */
export function threadTitleFrom(question: string): string {
  const firstLine = question.trim().split('\n')[0] ?? ''
  const limit = Math.min(GUIDED_REVIEW_TITLE_MAX, 80)
  return firstLine.length <= limit ? firstLine : `${firstLine.slice(0, limit - 1)}…`
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, LIST_MAX) : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function severityOf(value: unknown): GuidedReviewRiskSeverity {
  return value === 'high' || value === 'low' ? value : 'medium'
}

function paths(value: unknown): string[] {
  return list(value)
    .map((p) => str(p, 1024))
    .filter(Boolean)
}

function anchor(value: unknown): GuidedReviewAnchor | null {
  const raw = record(value)
  const candidate = {
    path: str(raw.path, 1024),
    ...(Number.isInteger(raw.startLine) && (raw.startLine as number) >= 1
      ? { startLine: raw.startLine as number }
      : {}),
    ...(Number.isInteger(raw.endLine) && (raw.endLine as number) >= 1
      ? { endLine: raw.endLine as number }
      : {}),
    ...(raw.side === 'LEFT' || raw.side === 'RIGHT' ? { side: raw.side } : {}),
  }
  return parseGuidedReviewAnchor(candidate)
}

/**
 * The overview the model returned, lenient on shape: entries missing their essentials are dropped,
 * lists are capped, and suggested questions get the ids a client posts back. Null when nothing
 * usable came back.
 */
export function coerceOverview(
  raw: unknown,
  newQuestionId: () => string,
): GuidedReviewOverviewContent | null {
  const r = record(raw)
  const summary = str(r.summary, PROSE_MAX)
  if (!summary) return null
  const candidate: GuidedReviewOverviewContent = {
    summary,
    intent: str(r.intent, PROSE_MAX),
    meaningfulChanges: list(r.meaningfulChanges)
      .map(record)
      .map((c) => ({
        title: str(c.title, GUIDED_REVIEW_TITLE_MAX),
        detail: str(c.detail, PROSE_MAX),
        paths: paths(c.paths),
      }))
      .filter((c) => c.title),
    consequences: list(r.consequences)
      .map(record)
      .map((c) => ({
        title: str(c.title, GUIDED_REVIEW_TITLE_MAX),
        detail: str(c.detail, PROSE_MAX),
      }))
      .filter((c) => c.title),
    risks: list(r.risks)
      .map(record)
      .map((c) => ({
        title: str(c.title, GUIDED_REVIEW_TITLE_MAX),
        detail: str(c.detail, PROSE_MAX),
        severity: severityOf(c.severity),
        paths: paths(c.paths),
      }))
      .filter((c) => c.title),
    focusAreas: list(r.focusAreas)
      .map(record)
      .map((c) => ({
        title: str(c.title, GUIDED_REVIEW_TITLE_MAX),
        why: str(c.why, PROSE_MAX),
        anchors: list(c.anchors)
          .map(anchor)
          .filter((a): a is GuidedReviewAnchor => a !== null),
      }))
      .filter((c) => c.title),
    suggestedQuestions: list(r.suggestedQuestions)
      .map((q) => str(typeof q === 'string' ? q : record(q).question, 1000))
      .filter(Boolean)
      .map((question) => ({ id: newQuestionId(), question })),
  }
  return parseGuidedReviewOverviewContent(candidate)
}

/** An answer reply: markdown plus the spans it rests on. Null when there is no answer text. */
export function coerceAnswer(
  raw: unknown,
): { content: string; citations: GuidedReviewAnchor[] } | null {
  const r = record(raw)
  const content = str(r.answer, GUIDED_REVIEW_ANSWER_MAX)
  if (!content) return null
  const citations = list(r.citations)
    .map(anchor)
    .filter((a): a is GuidedReviewAnchor => a !== null)
  return { content: redactSecrets(content) ?? '', citations }
}

/** The drafting reply's proposals, before anchoring. Incomplete entries are kept for the report. */
export function coerceDraftProposals(raw: unknown): {
  proposals: DraftProposal[]
  incomplete: { path: string; line: number | null; side: GuidedReviewDiffSide }[]
} {
  const proposals: DraftProposal[] = []
  const incomplete: { path: string; line: number | null; side: GuidedReviewDiffSide }[] = []
  for (const entry of list(record(raw).comments).map(record)) {
    const path = str(entry.path, 1024).replace(/^\.?\/+/, '')
    const side: GuidedReviewDiffSide = entry.side === 'LEFT' ? 'LEFT' : 'RIGHT'
    const line =
      Number.isInteger(entry.line) && (entry.line as number) >= 1 ? (entry.line as number) : null
    const body = str(entry.body, GUIDED_REVIEW_COMMENT_MAX)
    if (!path || line === null || !body) {
      incomplete.push({ path: path || '(none)', line, side })
      continue
    }
    const startLine =
      Number.isInteger(entry.startLine) &&
      (entry.startLine as number) >= 1 &&
      (entry.startLine as number) < line
        ? (entry.startLine as number)
        : null
    proposals.push({
      path,
      line,
      startLine,
      side,
      body: redactSecrets(body) ?? '',
      rationale: str(entry.rationale, PROSE_MAX),
    })
  }
  return { proposals, incomplete }
}

/**
 * Keep the proposals a host would accept: the path is a file the PR changes and the line sits
 * inside a hunk on that side. A multi-line span that leaves its hunk is narrowed to its last line
 * rather than dropped, since the host refuses a span crossing hunks. Everything refused is named
 * in the report.
 */
export function anchorDrafts(
  proposals: DraftProposal[],
  incomplete: { path: string; line: number | null; side: GuidedReviewDiffSide }[],
  files: GitHubChangedFile[],
): { kept: DraftProposal[]; report: GuidedReviewDraftReport } {
  const commentable = computeCommentableLines(files)
  const changed = new Set(files.map((f) => f.path))
  const kept: DraftProposal[] = []
  const dropped: GuidedReviewDraftReport['dropped'] = incomplete.map((d) => ({
    ...d,
    reason: 'incomplete' as const,
  }))
  for (const p of proposals) {
    if (!changed.has(p.path)) {
      dropped.push({ path: p.path, line: p.line, side: p.side, reason: 'not_in_pr' })
      continue
    }
    const lines = commentable.get(p.path)
    const sideLines = p.side === 'RIGHT' ? lines?.right : lines?.left
    if (!sideLines?.has(p.line)) {
      dropped.push({ path: p.path, line: p.line, side: p.side, reason: 'outside_diff' })
      continue
    }
    const startLine =
      p.startLine !== null && spanWithinHunk(sideLines, p.startLine, p.line) ? p.startLine : null
    kept.push({ ...p, startLine })
  }
  return {
    kept,
    report: { proposed: proposals.length + incomplete.length, dropped: dropped.slice(0, LIST_MAX) },
  }
}

/**
 * Whether a host would accept a comment at `anchor`: its line is inside the diff on its side and a
 * span starts before that line without leaving its hunk. The rule `anchorDrafts` keeps by, applied
 * to an anchor a human chose, so an edit cannot place a draft the post would then fail on.
 */
export function isCommentableAnchor(
  files: GitHubChangedFile[],
  anchor: { path: string; line: number; startLine: number | null; side: GuidedReviewDiffSide },
): boolean {
  const lines = computeCommentableLines(files).get(anchor.path)
  const sideLines = anchor.side === 'RIGHT' ? lines?.right : lines?.left
  if (!sideLines?.has(anchor.line)) return false
  if (anchor.startLine === null) return true
  return anchor.startLine < anchor.line && spanWithinHunk(sideLines, anchor.startLine, anchor.line)
}

/** Whether every line of `start..end` is commentable on one side, which holds only inside a hunk. */
function spanWithinHunk(sideLines: ReadonlySet<number>, start: number, end: number): boolean {
  for (let line = start; line <= end; line++) {
    if (!sideLines.has(line)) return false
  }
  return true
}

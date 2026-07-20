import type {
  CreateReviewComment,
  CreateReviewInput,
  CreateReviewResult,
  GitHubChangedFile,
  PrReviewAgentOutput,
  PrReviewFinding,
  PrReviewPostReport,
  PrReviewSeverity,
  PrReviewSlice,
  PrReviewStepState,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure PR-review helpers: turn the read-only `pr-reviewer` agent's lenient structured
// output into the id-stamped, severity-ordered `step.prReview` state the engine parks on
// and the window renders. No engine state, no IO — unit-tested directly.
// ---------------------------------------------------------------------------

/** Severity ordering, blocker-first, for sorting the aggregated findings. */
const SEVERITY_RANK: Record<PrReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
}

/** The blocker-first rank of a severity (unknown → medium's rank, matching the fallback). */
export function severityRank(severity: PrReviewSeverity): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.medium
}

/** The coerced, id-stamped review the engine records onto `step.prReview`. */
export interface CoercedPrReview {
  summary: string | null
  slices: PrReviewSlice[]
  findings: PrReviewFinding[]
}

/**
 * The in-flight review state seeded onto a `pr-reviewer` step the moment its container job is
 * dispatched, so a review run surfaces a real `reviewing` phase in the deep-review window — the
 * reviewed PR, the model, and (via the step's live todo subtasks) the slices-reviewed-so-far
 * progress — instead of an empty panel until the findings land. It is superseded by
 * {@link coercePrReview}'s result when the reviewer returns (`awaiting_selection`/`done`); the
 * `recordFindings` interceptor treats this `reviewing` status as "not yet recorded" and coerces
 * over it, while any later status short-circuits as already-settled.
 */
export function initialPrReviewState(
  prUrl: string | null,
  model: string | null,
  reviewedHeadSha: string | null = null,
): PrReviewStepState {
  return {
    status: 'reviewing',
    summary: null,
    slices: [],
    findings: [],
    selectedFindingIds: [],
    resolution: null,
    prUrl,
    model,
    reviewedHeadSha,
    postReport: null,
    postedFindingIds: [],
    postedBody: false,
  }
}

/**
 * Coerce the reviewer's lenient output into the persisted review shape: mint stable ids for
 * every slice + finding, anchor each finding to the slice that lists its path (first match
 * wins), drop empty slices/findings, and sort the findings blocker-first. Deterministic and
 * total — a missing/degenerate output yields an empty review rather than throwing (the caller
 * then treats a findings-empty review as "nothing to select" and advances).
 */
export function coercePrReview(
  output: PrReviewAgentOutput | undefined,
  mintSliceId: () => string,
  mintFindingId: () => string,
): CoercedPrReview {
  const slices: PrReviewSlice[] = (output?.slices ?? [])
    .map((s) => ({
      title: s.title?.trim() ?? '',
      rationale: s.rationale?.trim() ?? '',
      paths: (s.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0),
    }))
    // A slice with no name AND no paths carries no information — drop it.
    .filter((s) => s.title.length > 0 || s.paths.length > 0)
    .map((s) => ({
      id: mintSliceId(),
      title: s.title || 'Slice',
      rationale: s.rationale,
      paths: s.paths,
    }))

  // path → sliceId (first slice that lists the path wins), so a finding anchors to its slice.
  const sliceByPath = new Map<string, string>()
  for (const slice of slices) {
    for (const path of slice.paths) {
      if (!sliceByPath.has(path)) sliceByPath.set(path, slice.id)
    }
  }

  const findings: PrReviewFinding[] = (output?.findings ?? [])
    .map((f) => ({
      path: f.path?.trim() ?? '',
      line: f.line ?? null,
      side: f.side ?? null,
      severity: f.severity,
      category: f.category,
      title: f.title?.trim() ?? '',
      detail: f.detail?.trim() ?? '',
      suggestedFix: f.suggestedFix?.trim() || null,
    }))
    // A finding with no headline AND no detail is noise — drop it.
    .filter((f) => f.title.length > 0 || f.detail.length > 0)
    .map((f) => ({
      id: mintFindingId(),
      sliceId: (f.path && sliceByPath.get(f.path)) ?? null,
      path: f.path,
      line: f.line,
      side: f.side,
      severity: f.severity,
      category: f.category,
      title: f.title || 'Finding',
      detail: f.detail,
      suggestedFix: f.suggestedFix,
    }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  return { summary: output?.summary?.trim() || null, slices, findings }
}

// ---------------------------------------------------------------------------
// PR-review RESOLUTION rendering (PR 3): the two terminal actions the human picks in the
// window turn the selected findings into either a Fixer prompt (`fix`) or a batch of inline
// PR review comments (`post`). Both are pure/deterministic and unit-tested directly.
// ---------------------------------------------------------------------------

/** One selected finding rendered as a Markdown review-comment body (shared by both resolutions). */
function renderFindingBody(finding: PrReviewFinding): string {
  const parts = [
    `**[${finding.severity} · ${finding.category}] ${finding.title}**`,
    '',
    finding.detail,
  ]
  if (finding.suggestedFix) parts.push('', `**Suggested fix:** ${finding.suggestedFix}`)
  return parts.join('\n')
}

/**
 * Render the human-selected findings into the instruction block handed to the Fixer (fed as a
 * prior output on the fixer dispatch — the same injection point the gate helpers use). The
 * Fixer clones the reviewed PR's head branch, addresses each finding, and pushes back onto it.
 * Bulleted most-severe-first (the findings are already severity-sorted); each line carries the
 * location, severity/category, headline, detail and any suggested fix.
 */
export function renderPrReviewFixerFeedback(findings: PrReviewFinding[]): string {
  const lines: string[] = [
    'A code reviewer deep-reviewed this pull request and a human selected the findings below to ' +
      'ACT ON. Address every one: make the change on the checked-out PR branch, then commit and ' +
      'push it back onto the SAME branch (do NOT open a new pull request). Group related fixes ' +
      'into coherent commits.',
    '',
    'Findings to address (most severe first):',
  ]
  for (const finding of findings) {
    const location = finding.line != null ? `${finding.path}:${finding.line}` : finding.path
    lines.push('', `- [${finding.severity} · ${finding.category}] ${location} — ${finding.title}`)
    if (finding.detail) lines.push(`  ${finding.detail}`)
    if (finding.suggestedFix) lines.push(`  Suggested fix: ${finding.suggestedFix}`)
  }
  return lines.join('\n')
}

/** The set of lines a PR comment can anchor to, per side of the diff, for one file. */
export interface CommentableLines {
  /** New-file line numbers on the head side (added + context lines). */
  right: Set<number>
  /** Old-file line numbers on the base side (removed + context lines). */
  left: Set<number>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Compute, per changed file, the exact lines an inline PR comment can anchor to — the ROOT-CAUSE
 * guard against GitHub's "Line could not be resolved" 422. GitHub only accepts an inline comment
 * on a line that is part of the diff: on the RIGHT (head) side, an added (`+`) or context (` `)
 * line; on the LEFT (base) side, a removed (`-`) or context line. A finding the reviewer anchored
 * to any other line (very common — the model cites a line elsewhere in the file) can't be posted
 * inline, so {@link buildPrReviewPost} folds it into the summary instead of letting the whole post
 * 422. Parses each file's unified-diff `patch`; a file with a null patch (binary / too-large diff)
 * is omitted, so its findings fall back to being posted directly (and reported if they fail).
 */
export function computeCommentableLines(files: GitHubChangedFile[]): Map<string, CommentableLines> {
  const out = new Map<string, CommentableLines>()
  for (const file of files) {
    if (!file.patch || !file.path) continue
    const lines: CommentableLines = { right: new Set(), left: new Set() }
    let oldLine = 0
    let newLine = 0
    for (const raw of file.patch.split('\n')) {
      const header = HUNK_HEADER.exec(raw)
      if (header) {
        oldLine = Number(header[1])
        newLine = Number(header[2])
        continue
      }
      const marker = raw[0]
      if (marker === '+') {
        lines.right.add(newLine)
        newLine++
      } else if (marker === '-') {
        lines.left.add(oldLine)
        oldLine++
      } else if (marker === '\\') {
        // "\ No newline at end of file" — advances neither side.
      } else {
        // A context line (leading space, or the diff's trailing blank line) is commentable on both.
        lines.right.add(newLine)
        lines.left.add(oldLine)
        newLine++
        oldLine++
      }
    }
    out.set(file.path, lines)
  }
  return out
}

/** A built PR-review post plus the finding→comment mapping the outcome report is keyed on. */
export interface BuiltPrReviewPost {
  input: CreateReviewInput
  /** Finding id for each `input.comments[i]`, so a per-comment outcome maps back to its finding. */
  commentFindingIds: string[]
  /** Findings that HAD a line but were folded into the summary (line outside the diff). */
  foldedFindingIds: string[]
}

/**
 * Turn the human-selected findings into a PR review to publish via `RepoFiles.createReview`.
 * A finding whose `path`/`line`/`side` anchors to an actual diff line becomes an inline comment;
 * a finding with no line — OR a line outside the diff (when `commentable` is supplied) — is folded
 * into the review `body` alongside the reviewer's `summary`, so it is surfaced rather than
 * rejected. When `commentable` is omitted (no diff available) every line-carrying finding is
 * attempted inline and any residual failure is reported per-comment. Deterministic + total.
 *
 * `options.staleHead` — set when the PR branch moved SINCE the review started (the reviewed head
 * sha no longer matches the PR's current head): the findings' frozen line numbers may now point at
 * shifted/different code, so NO finding is anchored inline. Every line-carrying finding is folded
 * into the summary under a heading that says the branch changed, so the review still lands (as one
 * summary comment) rather than stamping comments onto possibly-drifted lines. Overrides
 * `commentable`.
 *
 * The review always carries a non-empty `body` (GitHub rejects a blank-body comment): when
 * neither a summary nor any folded/unanchored finding supplies one, we fall back to a one-line
 * count of the inline comments.
 */
export function buildPrReviewPost(
  findings: PrReviewFinding[],
  summary: string | null | undefined,
  commentable?: Map<string, CommentableLines>,
  options?: { staleHead?: boolean },
): BuiltPrReviewPost {
  const staleHead = options?.staleHead === true
  const comments: CreateReviewComment[] = []
  const commentFindingIds: string[] = []
  const foldedFindingIds: string[] = []
  const unanchored: PrReviewFinding[] = []
  for (const finding of findings) {
    const side = finding.side ?? 'RIGHT'
    const anchorable =
      !staleHead &&
      finding.line != null &&
      finding.path.length > 0 &&
      (commentable === undefined ||
        (side === 'LEFT'
          ? commentable.get(finding.path)?.left.has(finding.line)
          : commentable.get(finding.path)?.right.has(finding.line)) === true)
    if (anchorable) {
      comments.push({
        path: finding.path,
        line: finding.line!,
        side,
        body: renderFindingBody(finding),
      })
      commentFindingIds.push(finding.id)
    } else {
      unanchored.push(finding)
      // A line-carrying finding we couldn't anchor was FOLDED to dodge the 422; a truly line-less
      // one is just naturally summarised. Only the former is reported as `folded`.
      if (finding.line != null && finding.path.length > 0) foldedFindingIds.push(finding.id)
    }
  }
  const bodyParts: string[] = []
  if (summary?.trim()) bodyParts.push(summary.trim())
  if (unanchored.length > 0) {
    bodyParts.push(
      staleHead
        ? 'Findings (the pull request branch was updated after this review started, so they are ' +
            'summarized here rather than anchored to lines that may have since shifted):'
        : 'Additional findings (no in-diff line to anchor to):',
      unanchored
        .map((f) => {
          const loc = f.line != null ? `${f.path}:${f.line}` : f.path
          return `- ${loc ? `\`${loc}\` — ` : ''}${renderFindingBody(f)}`
        })
        .join('\n\n'),
    )
  }
  if (bodyParts.length === 0) {
    bodyParts.push(
      `Deep review: ${comments.length} inline finding${comments.length === 1 ? '' : 's'}.`,
    )
  }
  return {
    input: { event: 'COMMENT', body: bodyParts.join('\n\n'), comments },
    commentFindingIds,
    foldedFindingIds,
  }
}

/** A post attempt reduced to the persisted report + the finding ids that newly posted. */
export interface PrReviewPostSummary {
  report: PrReviewPostReport
  /** Finding ids whose inline comment posted THIS attempt (to add to `postedFindingIds`). */
  newlyPostedFindingIds: string[]
}

/**
 * Reduce a `createReview` result into the persisted {@link PrReviewPostReport} + the finding ids
 * that newly posted, so the engine can record what landed, surface the failures, and skip the
 * already-posted findings on a retry. Pure + total. `built` supplies the finding→comment mapping;
 * `selected` resolves each failing finding's path/line for the report. `result` may be null when
 * no VCS write ran (nothing to post) — reported as an all-folded/no-op attempt.
 */
export function buildPrReviewPostReport(
  built: BuiltPrReviewPost,
  selected: PrReviewFinding[],
  result: CreateReviewResult | null,
): PrReviewPostSummary {
  const byId = new Map(selected.map((f) => [f.id, f]))
  const failures: PrReviewPostReport['failures'] = []
  const newlyPostedFindingIds: string[] = []
  const outcomes = result?.comments ?? []
  built.commentFindingIds.forEach((findingId, i) => {
    const outcome = outcomes[i]
    if (outcome?.posted) {
      newlyPostedFindingIds.push(findingId)
    } else {
      const finding = byId.get(findingId)
      failures.push({
        findingId,
        path: finding?.path ?? '',
        line: finding?.line ?? null,
        reason: outcome?.error ?? 'The comment was not posted.',
      })
    }
  })
  return {
    report: {
      attempted: built.commentFindingIds.length,
      posted: newlyPostedFindingIds.length,
      folded: built.foldedFindingIds.length,
      bodyPosted: result?.bodyPosted ?? null,
      bodyError: result?.bodyError ?? null,
      failures,
    },
    newlyPostedFindingIds,
  }
}

/** Whether a post attempt fully succeeded — every inline comment landed and the body (if any) posted. */
export function isPrReviewPostComplete(report: PrReviewPostReport): boolean {
  return report.failures.length === 0 && report.bodyPosted !== false
}

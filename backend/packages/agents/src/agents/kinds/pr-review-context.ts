import type {
  GitHubChangedFile,
  GitHubReviewThread,
  RepoOp,
  RepoOpContext,
  RepoOpResult,
} from '@cat-factory/kernel'
import type { ComposableFragment } from '../runtime/fragments.js'

// ---------------------------------------------------------------------------
// What the `pr-reviewer` is handed UP FRONT, as `.cat-context/*.md` files.
//
// The governing constraint is that an agentic loop re-sends its whole transcript on every
// turn, so ANYTHING placed in the reviewer's context is paid for again on each of the
// (hundreds of) turns that follow. A 10k-token file read early in a 400-turn review costs
// millions of tokens by the end. Everything here is therefore sized by "how many turns will
// carry this?", not by "does it fit?".
//
// Measured on a 437-turn review of a ~450-file PR, that produced three rules:
//
//  1. The reviewer slices from the changed-file LIST; its parallel slice subagents pull their
//     own diffs from git. Pre-inlining a large diff pays for a map nobody reads — that run
//     inlined 319 KB and the subagents referenced it once while running 141 `git diff`/`git
//     show` calls. So patches are inlined ONLY when the WHOLE diff is small enough to review
//     in one pass ({@link MAX_INLINE_DIFF_BYTES}); past that the file is a manifest and the
//     diffs are read per slice. All-or-nothing, because a half-inlined file is the worst case:
//     it is big AND the reviewer still has to probe it to find out what is missing.
//  2. A manifest the reviewer has to reverse-engineer costs more than one it can read. That
//     run spent 21 `grep`/`awk`/`sed`/`wc` probes working out the injected file's own shape,
//     each probe's output then carried for the rest of the review. So the manifest states the
//     per-directory rollup and a SUGGESTED SLICING outright ({@link planSlices}) — grouping
//     changed files is mechanical, and doing it here costs zero model turns.
//  3. Reference material is per-slice, so it must be readable per-slice. Existing review
//     threads are grouped under a path index, and best-practice standards go to one file each,
//     so a subagent greps or reads only its own — rather than the parent reading the whole lot
//     into a context that then carries it for every remaining turn.
// ---------------------------------------------------------------------------

/** The injected context file (under `.cat-context/`) the diff preOp writes for the reviewer. */
export const PR_DIFF_CONTEXT_FILE = 'pr-diff.md'

/** The injected context file listing the PR's already-posted review comments (for de-dup). */
export const PR_EXISTING_COMMENTS_CONTEXT_FILE = 'pr-existing-comments.md'

/** Filename prefix for the per-standard context files the standards preOp writes. */
export const PR_STANDARD_CONTEXT_PREFIX = 'standard-'

/**
 * Total inlined-patch budget. Under it, the WHOLE diff is inlined and a small PR is reviewable
 * in one pass with no git turns at all. Over it, no patch is inlined: the reviewer slices from
 * the manifest and each slice reads only its own files from the checkout — which is what the
 * parallel slice subagents do regardless, so inlining more only pays for the same bytes twice.
 */
const MAX_INLINE_DIFF_BYTES = 64 * 1024

/** Per-file inline cap: one generated blob (a lockfile, a snapshot) never crowds out the rest. */
const MAX_SINGLE_PATCH_BYTES = 32 * 1024

/**
 * Byte budget for the injected existing-comments file. Review threads are short prose, so this is
 * generous; past it, the remaining threads are summarised as a count so the file never dominates
 * the context on a PR with a very long comment history.
 */
const MAX_EXISTING_COMMENTS_BYTES = 64 * 1024

/** Path depth a suggested slice groups at — `src/Foo.Bar/Baz/x.cs` groups under `src/Foo.Bar`. */
const SLICE_GROUP_DEPTH = 2

/** A suggested slice is split once it exceeds either budget, so no single slice dwarfs the rest. */
const SLICE_MAX_FILES = 20
const SLICE_MAX_CHANGED_LINES = 2_500

/** Groups smaller than this are merged into a shared "assorted" slice rather than standing alone. */
const SLICE_MIN_FILES = 2

// ---------------------------------------------------------------------------
// PR number resolution
// ---------------------------------------------------------------------------

/** Resolve the reviewed PR's number from the block's task-type fields (prefer `prNumber`). */
export function resolvePrNumber(
  fields: { prNumber?: number; prUrl?: string } | undefined,
): number | null {
  if (!fields) return null
  if (
    typeof fields.prNumber === 'number' &&
    Number.isInteger(fields.prNumber) &&
    fields.prNumber > 0
  )
    return fields.prNumber
  const url = fields.prUrl?.trim()
  if (!url) return null
  // GitHub `/pull/<n>`, GitLab `/-/merge_requests/<n>`, or a trailing `#<n>` / `/<n>`.
  const m = url.match(/(?:pull|pulls|merge_requests)\/(\d+)|[#/](\d+)\s*$/)
  const raw = m?.[1] ?? m?.[2]
  const n = raw ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// Deterministic slice planning
// ---------------------------------------------------------------------------

/** One suggested review slice: a cohesive group of changed files, with its size. */
export interface SuggestedSlice {
  /** Short name — the grouping path, or `assorted` / a `(part N)` suffix when split. */
  title: string
  paths: string[]
  changedLines: number
}

/** The directory a path groups under: its leading {@link SLICE_GROUP_DEPTH} segments. */
function groupKey(path: string): string {
  const segments = path.split('/')
  segments.pop() // the filename
  if (segments.length === 0) return '(repo root)'
  return segments.slice(0, SLICE_GROUP_DEPTH).join('/')
}

function changedLinesOf(file: GitHubChangedFile): number {
  return file.additions + file.deletions
}

/**
 * Group the changed files into candidate review slices, deterministically and with no model
 * turns. Files group by their leading path segments (the project / module / top-level area),
 * one-off groups collapse into a shared `assorted` slice, and any group over
 * {@link SLICE_MAX_FILES} / {@link SLICE_MAX_CHANGED_LINES} is split into numbered parts.
 *
 * This is a SUGGESTION the reviewer may regroup — path adjacency is a good proxy for
 * "belongs together" but it cannot see that a refactor and its call sites live apart. Its
 * value is that the reviewer starts from a usable grouping instead of probing the file list
 * to build one, and that the size caps stop a single oversized slice forming: cost scales with
 * turns × context, so one slice big enough to need 100+ turns costs more than three that
 * replace it.
 */
export function planSlices(files: GitHubChangedFile[]): SuggestedSlice[] {
  const groups = new Map<string, GitHubChangedFile[]>()
  for (const file of files) {
    const key = groupKey(file.path)
    const bucket = groups.get(key)
    if (bucket) bucket.push(file)
    else groups.set(key, [file])
  }

  // Collapse one-off groups together: a slice per single changed file is pure overhead.
  const assorted: GitHubChangedFile[] = []
  const named: [string, GitHubChangedFile[]][] = []
  for (const [key, bucket] of groups) {
    if (bucket.length < SLICE_MIN_FILES) assorted.push(...bucket)
    else named.push([key, bucket])
  }
  if (assorted.length) named.push(['assorted', assorted])

  const slices: SuggestedSlice[] = []
  for (const [key, bucket] of named) {
    // Largest-first within a group, so a split keeps the heavy files spread across parts
    // rather than stacking them all into part 1.
    const sorted = [...bucket].sort((a, b) => changedLinesOf(b) - changedLinesOf(a))
    const parts: GitHubChangedFile[][] = [[]]
    let lines = 0
    for (const file of sorted) {
      const current = parts[parts.length - 1]!
      const wouldExceed =
        current.length >= SLICE_MAX_FILES ||
        (current.length > 0 && lines + changedLinesOf(file) > SLICE_MAX_CHANGED_LINES)
      if (wouldExceed) {
        parts.push([file])
        lines = changedLinesOf(file)
      } else {
        current.push(file)
        lines += changedLinesOf(file)
      }
    }
    for (const [index, part] of parts.entries()) {
      if (part.length === 0) continue
      slices.push({
        title: parts.length > 1 ? `${key} (part ${index + 1})` : key,
        // Back to path order within the slice, so the list reads like the repo.
        paths: part.map((f) => f.path).sort(),
        changedLines: part.reduce((sum, f) => sum + changedLinesOf(f), 0),
      })
    }
  }
  return slices.sort((a, b) => b.changedLines - a.changedLines)
}

// ---------------------------------------------------------------------------
// `.cat-context/pr-diff.md`
// ---------------------------------------------------------------------------

/** Per-directory rollup of the change, so the reviewer sees the shape without probing. */
function renderDirectoryRollup(files: GitHubChangedFile[]): string[] {
  const rollup = new Map<string, { files: number; lines: number }>()
  for (const file of files) {
    const key = groupKey(file.path)
    const entry = rollup.get(key) ?? { files: 0, lines: 0 }
    entry.files += 1
    entry.lines += changedLinesOf(file)
    rollup.set(key, entry)
  }
  const rows = [...rollup.entries()].sort((a, b) => b[1].lines - a[1].lines)
  return [
    `\n## Change shape (${rows.length} areas)\n`,
    ...rows.map(([key, e]) => `- ${key} — ${e.files} file(s), ${e.lines} changed line(s)`),
  ]
}

function renderSuggestedSlices(slices: SuggestedSlice[]): string[] {
  return [
    `\n## Suggested slicing (${slices.length} slices)\n`,
    'Grouped mechanically by path and capped by size, so you can start from it instead of',
    'deriving one. REGROUP where you know better — a refactor and its call sites often live in',
    'different areas — but do not exceed these sizes: an oversized slice costs more than the two',
    'that would replace it, because every extra turn re-sends the whole slice context.\n',
    ...slices.map(
      (s) =>
        `- **${s.title}** (${s.paths.length} file(s), ${s.changedLines} changed line(s))\n` +
        s.paths.map((p) => `  - ${p}`).join('\n'),
    ),
  ]
}

/** The header for the manifest-only (large PR) shape: how to read a slice's diffs from git. */
function largePrGuidance(files: number, bytes: number): string {
  return (
    `\n## Patches — NOT inlined (${files} files, ~${Math.ceil(bytes / 1024)} KiB of patch)\n\n` +
    'This diff is too large to inline: it would sit in context for every turn of the review while ' +
    'each slice needs only its own files. Read each slice’s diff when you review that slice:\n\n' +
    '```sh\n' +
    'git diff origin/<base>...origin/pr-head -- <path>   # the head diff for one file\n' +
    'git show origin/pr-head:<path>                      # a file’s full body at the PR head\n' +
    '```\n\n' +
    "Read a RANGE, not a whole large file (`| sed -n '<from>,<to>p'`), and never re-read something " +
    'you already have — both stay in context for the rest of the review.\n'
  )
}

/**
 * Render the changed-file list, the change shape, a suggested slicing, and — only for a diff
 * small enough to review in one pass — the patches, as the injected `.cat-context/pr-diff.md`.
 * See the module header for why the patch budget is all-or-nothing.
 */
export function renderPrDiffContext(number: number, files: GitHubChangedFile[]): string {
  const enc = new TextEncoder()
  // Oversized single patches never inline, and never count toward the inline decision — one
  // generated blob must not push an otherwise-small PR onto the manifest-only path.
  const inlinable = files.filter(
    (f) => f.patch != null && enc.encode(f.patch).length <= MAX_SINGLE_PATCH_BYTES,
  )
  const inlineBytes = inlinable.reduce((sum, f) => sum + enc.encode(f.patch ?? '').length, 0)
  const inlinePatches = inlineBytes <= MAX_INLINE_DIFF_BYTES

  const header =
    `# Pull request #${number} — changed files and diff\n\n` +
    'Prepared from the API so you can plan your review slices WITHOUT reconstructing the diff ' +
    'yourself. You have the full base checkout AND (usually) the PR head fetched as ' +
    '`origin/pr-head`.\n'

  const list = [
    `\n## Changed files (${files.length})\n`,
    ...files.map((f) => {
      const rename = f.previousPath ? ` (renamed from ${f.previousPath})` : ''
      return `- ${f.status} ${f.path} (+${f.additions}/-${f.deletions})${rename}`
    }),
  ]

  const sections = [
    header,
    list.join('\n'),
    renderDirectoryRollup(files).join('\n'),
    renderSuggestedSlices(planSlices(files)).join('\n'),
  ]

  if (!inlinePatches) {
    sections.push(largePrGuidance(files.length, inlineBytes))
    return `${sections.join('\n')}\n`
  }

  const patches: string[] = ['\n## Patches\n']
  for (const f of files) {
    const heading = `\n### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n`
    if (f.patch == null) {
      patches.push(`${heading}(no patch — binary or too large; read the file from the checkout)\n`)
    } else if (enc.encode(f.patch).length > MAX_SINGLE_PATCH_BYTES) {
      const kib = Math.ceil(enc.encode(f.patch).length / 1024)
      patches.push(
        `${heading}(patch ~${kib} KiB — over the per-file inline budget; read it with ` +
          '`git show origin/pr-head:<path>`)\n',
      )
    } else {
      patches.push(`${heading}\`\`\`diff\n${f.patch}\n\`\`\`\n`)
    }
  }
  sections.push(patches.join(''))
  return `${sections.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// `.cat-context/pr-existing-comments.md`
// ---------------------------------------------------------------------------

/** A single review-thread comment's body, trimmed + collapsed to a one-liner excerpt for the list. */
function commentExcerpt(body: string, max = 500): string {
  const flat = body.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function renderThread(thread: GitHubReviewThread): string {
  const anchor = thread.path
    ? `${thread.path}${thread.line != null ? `:${thread.line}` : ''}`
    : 'general'
  const state = thread.isResolved ? 'RESOLVED' : 'UNRESOLVED'
  const first = thread.comments[0]
  const author = first?.author ? `@${first.author}` : 'unknown'
  const excerpt = first ? commentExcerpt(first.body) : '(no comment body)'
  const extra = thread.comments.length - 1
  const replies = extra > 0 ? ` (+${extra} repl${extra === 1 ? 'y' : 'ies'})` : ''
  return `\n### ${anchor} — ${state}\n${author}${replies}: ${excerpt}\n`
}

/**
 * Render the PR's existing review threads as `.cat-context/pr-existing-comments.md`, so the
 * reviewer de-dups against findings already raised (prior rounds / humans / other bots).
 *
 * Threads are GROUPED BY FILE under a path index. De-dup is a per-slice concern, so a slice
 * reviewer should grep out the handful of threads on its own paths; reading the whole file
 * into the parent's context makes every remaining turn of the review pay for all of them.
 */
export function renderExistingReviewComments(
  number: number,
  threads: GitHubReviewThread[],
): string {
  const header =
    `# Pull request #${number} — existing review comments\n\n` +
    'These findings have ALREADY been raised on this PR (earlier rounds, human reviewers, or other ' +
    'bots). Do NOT re-report an issue an existing comment already covers. Skip UNRESOLVED threads ' +
    '(already awaiting action); re-raise a RESOLVED thread only if the change shows its fix is wrong ' +
    'or incomplete.\n\n' +
    'Threads are grouped by file below. When reviewing ONE slice, read only that slice’s files — ' +
    '`grep -n -A2 "^### <path>" .cat-context/pr-existing-comments.md` — rather than the whole file.\n'

  // Insertion-ordered by first appearance, so the index reads in the order the API returned.
  const byPath = new Map<string, GitHubReviewThread[]>()
  for (const thread of threads) {
    const key = thread.path ?? '(general)'
    const bucket = byPath.get(key)
    if (bucket) bucket.push(thread)
    else byPath.set(key, [thread])
  }

  const index = [
    `\n## Files with existing threads (${byPath.size})\n`,
    ...[...byPath.entries()].map(([path, list]) => `- ${path} (${list.length} thread(s))`),
  ]

  const enc = new TextEncoder()
  let bytes = 0
  let omitted = 0
  const sections: string[] = [`\n## Threads (${threads.length})\n`]
  for (const [path, list] of byPath) {
    const block = `\n## ${path}\n${list.map(renderThread).join('')}`
    const size = enc.encode(block).length
    if (bytes + size > MAX_EXISTING_COMMENTS_BYTES) {
      omitted += list.length
      continue
    }
    bytes += size
    sections.push(block)
  }
  const footer =
    omitted > 0
      ? `\n_${omitted} more thread(s) omitted to stay within the injected-context budget._\n`
      : ''
  return `${header}${index.join('\n')}\n${sections.join('')}${footer}`
}

// ---------------------------------------------------------------------------
// `.cat-context/standard-<id>.md`
// ---------------------------------------------------------------------------

/**
 * The `.cat-context/` filename a resolved best-practice standard is written to. Non-portable
 * characters are stripped to match the harness's context-file sanitizer exactly (it keeps only
 * `[A-Za-z0-9._-]` and flattens any directory), so the name in the index is the name on disk.
 */
export function standardsContextFileName(fragmentId: string): string {
  const slug = fragmentId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'unnamed'
  return `${PR_STANDARD_CONTEXT_PREFIX}${slug}.md`
}

/** Render one standard as its own context file, with the title the reviewer cites it by. */
export function renderStandardContext(fragment: ComposableFragment): string {
  const title = fragment.title?.trim() || fragment.id
  return (
    `# ${title}\n\n` +
    `Best-practice standard \`${fragment.id}\`, selected for this review task. Cite it by its ` +
    'title in `fragmentAdherence`.\n\n' +
    '---\n\n' +
    `${fragment.body.trim()}\n`
  )
}

/** Render the index that tells the reviewer which standards exist and where each one is. */
export function renderStandardsIndex(fragments: ComposableFragment[]): string {
  return (
    '# Best-practice standards for this review\n\n' +
    'These are the standards this review is judged against. Each is a SEPARATE file so a slice ' +
    'reviewer reads only the ones its slice needs — do not read them all into one context.\n\n' +
    'When you dispatch a slice reviewer, name the standards that apply to that slice and tell it ' +
    'to READ those files itself. Do NOT paraphrase a standard into the subagent’s prompt: a ' +
    'summary is not the standard, and `fragmentAdherence` ratings must come from the real text.\n\n' +
    fragments
      .map(
        (f) =>
          `- **${f.title?.trim() || f.id}** (\`${f.id}\`) — \`.cat-context/${standardsContextFileName(f.id)}\``,
      )
      .join('\n') +
    '\n'
  )
}

/** The index file listing every injected standard. */
export const PR_STANDARDS_INDEX_CONTEXT_FILE = 'standards.md'

// ---------------------------------------------------------------------------
// PreOps
// ---------------------------------------------------------------------------

/**
 * PreOp for the `pr-reviewer` kind: hand the reviewer the PR's changed-file list, change shape and
 * a suggested slicing as `.cat-context/pr-diff.md` (plus the patches when the whole diff is small
 * enough to review in one pass). Pass-through — injecting nothing, so the prompt's git fallback
 * runs — when the PR number can't be resolved, the bound client can't list changed files
 * (unwired / a VCS provider without the capability), or the PR reports no changed files.
 */
export const prReviewerDiffPreOp: RepoOp = async (
  ctx: RepoOpContext,
): Promise<RepoOpResult | void> => {
  const listChangedFiles = ctx.repo.listChangedFiles
  if (!listChangedFiles) return
  const number = resolvePrNumber(ctx.context.block.taskTypeFields)
  if (number == null) return
  const files = await listChangedFiles(number)
  if (!files.length) return
  return {
    contextFiles: [{ path: PR_DIFF_CONTEXT_FILE, content: renderPrDiffContext(number, files) }],
  }
}

/**
 * PreOp for the `pr-reviewer` kind: hand the reviewer the PR's EXISTING review threads up front as
 * `.cat-context/pr-existing-comments.md`, grouped by file, so it de-dups against findings already
 * raised instead of re-reporting them. Pass-through — injecting nothing — when the PR number can't
 * be resolved, the bound client can't read review threads, or the PR has no review threads yet.
 */
export const prReviewerExistingCommentsPreOp: RepoOp = async (
  ctx: RepoOpContext,
): Promise<RepoOpResult | void> => {
  const listReviewThreads = ctx.repo.listReviewThreads
  if (!listReviewThreads) return
  const number = resolvePrNumber(ctx.context.block.taskTypeFields)
  if (number == null) return
  const threads = await listReviewThreads(number)
  if (!threads.length) return
  return {
    contextFiles: [
      {
        path: PR_EXISTING_COMMENTS_CONTEXT_FILE,
        content: renderExistingReviewComments(number, threads),
      },
    ],
  }
}

/**
 * PreOp for the `pr-reviewer` kind: write the task's selected best-practice standards as one
 * `.cat-context/standard-<id>.md` file each, plus an index.
 *
 * The reviewer's own prompt does NOT carry the standards (the kind declares
 * `standardsDelivery: 'context-files'`, so the engine skips the fold). Folding them in charged
 * the parent for every standard on every turn — 145 KB across 5 standards on the measured run,
 * ~3.7M tokens over 96 turns — while the agents that actually review the code, the parallel slice
 * subagents, never received them and worked from the parent's one-line paraphrase instead. As
 * files, each standard is read once by the slices it applies to, from the real text.
 *
 * Pass-through when the run resolved no fragments (a review task with none selected).
 */
export const prReviewerStandardsPreOp: RepoOp = async (
  ctx: RepoOpContext,
): Promise<RepoOpResult | void> => {
  const fragments = ctx.context.block.resolvedFragments ?? []
  if (!fragments.length) return
  return {
    contextFiles: [
      { path: PR_STANDARDS_INDEX_CONTEXT_FILE, content: renderStandardsIndex(fragments) },
      ...fragments.map((fragment) => ({
        path: standardsContextFileName(fragment.id),
        content: renderStandardContext(fragment),
      })),
    ],
  }
}

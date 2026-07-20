import type {
  AgentRunContext,
  GitHubChangedFile,
  GitHubReviewThread,
  RepoFiles,
  RepoOpContext,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, hasTrait } from './traits.js'
import {
  PR_DIFF_CONTEXT_FILE,
  PR_EXISTING_COMMENTS_CONTEXT_FILE,
  PR_REVIEWER_KIND,
  prReviewerDiffPreOp,
  prReviewerExistingCommentsPreOp,
  renderExistingReviewComments,
  renderPrDiffContext,
  resolvePrNumber,
} from './pr-reviewer.js'

function changedFile(over: Partial<GitHubChangedFile> = {}): GitHubChangedFile {
  return {
    path: 'src/a.ts',
    previousPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...over,
  }
}

function reviewThread(over: Partial<GitHubReviewThread> = {}): GitHubReviewThread {
  return {
    id: 'T1',
    isResolved: false,
    path: 'src/a.ts',
    line: 42,
    comments: [{ author: 'octocat', body: 'This looks off.', createdAt: 0 }],
    ...over,
  }
}

/** A RepoOpContext exposing only what the preOp reads: `repo.listChangedFiles` + the PR fields. */
function ctxWith(
  listChangedFiles: RepoFiles['listChangedFiles'],
  taskTypeFields: { prNumber?: number; prUrl?: string } | undefined,
): RepoOpContext {
  return {
    repo: { listChangedFiles } as unknown as RepoFiles,
    context: { block: { taskTypeFields } } as unknown as AgentRunContext,
    branch: 'main',
    opensPr: false,
  }
}

/** A RepoOpContext exposing only `repo.listReviewThreads` + the PR fields (for the comments preOp). */
function ctxWithThreads(
  listReviewThreads: RepoFiles['listReviewThreads'],
  taskTypeFields: { prNumber?: number; prUrl?: string } | undefined,
): RepoOpContext {
  return {
    repo: { listReviewThreads } as unknown as RepoFiles,
    context: { block: { taskTypeFields } } as unknown as AgentRunContext,
    branch: 'main',
    opensPr: false,
  }
}

describe('resolvePrNumber', () => {
  it('prefers a valid prNumber', () => {
    expect(resolvePrNumber({ prNumber: 42, prUrl: 'https://github.com/o/r/pull/7' })).toBe(42)
  })
  it('parses a GitHub pull URL', () => {
    expect(resolvePrNumber({ prUrl: 'https://github.com/o/r/pull/123' })).toBe(123)
  })
  it('parses a GitLab merge-request URL', () => {
    expect(resolvePrNumber({ prUrl: 'https://gitlab.com/o/r/-/merge_requests/55' })).toBe(55)
  })
  it('parses a trailing #<n>', () => {
    expect(resolvePrNumber({ prUrl: 'o/r#88' })).toBe(88)
  })
  it('returns null for a missing/zero/non-numeric ref', () => {
    expect(resolvePrNumber(undefined)).toBeNull()
    expect(resolvePrNumber({})).toBeNull()
    expect(resolvePrNumber({ prNumber: 0 })).toBeNull()
    expect(resolvePrNumber({ prUrl: 'not a url' })).toBeNull()
  })
})

describe('renderPrDiffContext', () => {
  it('lists every changed file and includes each patch', () => {
    const out = renderPrDiffContext(9, [
      changedFile({ path: 'src/a.ts' }),
      changedFile({ path: 'src/b.ts', status: 'added', patch: '@@ +1 @@\n+hi' }),
    ])
    expect(out).toContain('# Pull request #9')
    expect(out).toContain('## Changed files (2)')
    expect(out).toContain('- modified src/a.ts (+3/-1)')
    expect(out).toContain('- added src/b.ts')
    expect(out).toContain('+new')
    expect(out).toContain('+hi')
  })

  it('notes a rename and a null (binary/oversized) patch instead of a diff block', () => {
    const out = renderPrDiffContext(1, [
      changedFile({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', patch: null }),
    ])
    expect(out).toContain('(renamed from old.ts)')
    expect(out).toContain('(no patch — binary or too large; read the file from the checkout)')
  })

  it('always keeps the full file list but omits patches over the byte budget', () => {
    // 40 files each with a ~10 KiB patch (~400 KiB) exceeds the 256 KiB patch budget.
    const big = '+x\n'.repeat(3400) // ~10 KiB
    const files = Array.from({ length: 40 }, (_, i) =>
      changedFile({ path: `src/f${i}.ts`, patch: big }),
    )
    const out = renderPrDiffContext(2, files)
    // Every file is still listed (the cheap slicing signal is never dropped) ...
    expect(out).toContain('## Changed files (40)')
    for (let i = 0; i < 40; i++) expect(out).toContain(`src/f${i}.ts`)
    // ... but some patches are omitted with an explicit note.
    expect(out).toMatch(/patch\(es\) omitted to stay within the injected-diff budget/)
  })
})

describe('prReviewerDiffPreOp', () => {
  it('injects .cat-context/pr-diff.md when the client lists changed files', async () => {
    const result = await prReviewerDiffPreOp(ctxWith(async () => [changedFile()], { prNumber: 12 }))
    expect(result?.contextFiles).toHaveLength(1)
    expect(result?.contextFiles?.[0]?.path).toBe(PR_DIFF_CONTEXT_FILE)
    expect(result?.contextFiles?.[0]?.content).toContain('# Pull request #12')
    expect(result?.pullRequest).toBeUndefined()
  })

  it('resolves the PR number from prUrl when prNumber is absent', async () => {
    let askedNumber = -1
    const result = await prReviewerDiffPreOp(
      ctxWith(
        async (n) => {
          askedNumber = n
          return [changedFile()]
        },
        { prUrl: 'https://github.com/o/r/pull/321' },
      ),
    )
    expect(askedNumber).toBe(321)
    expect(result?.contextFiles?.[0]?.content).toContain('# Pull request #321')
  })

  it('passes through (no injection) when the client can not list changed files', async () => {
    expect(await prReviewerDiffPreOp(ctxWith(undefined, { prNumber: 12 }))).toBeUndefined()
  })

  it('passes through when the PR number can not be resolved', async () => {
    let called = false
    await prReviewerDiffPreOp(
      ctxWith(async () => {
        called = true
        return [changedFile()]
      }, {}),
    )
    expect(called).toBe(false)
  })

  it('passes through when the PR reports no changed files', async () => {
    expect(await prReviewerDiffPreOp(ctxWith(async () => [], { prNumber: 12 }))).toBeUndefined()
  })
})

describe('renderExistingReviewComments', () => {
  it('lists each thread with anchor, resolved state and the opening comment', () => {
    const out = renderExistingReviewComments(9, [
      reviewThread({ path: 'src/a.ts', line: 10, isResolved: false }),
      reviewThread({
        id: 'T2',
        path: 'src/b.ts',
        line: 20,
        isResolved: true,
        comments: [
          { author: 'human', body: 'Handle the null case.', createdAt: 0 },
          { author: 'bot', body: 'Fixed.', createdAt: 1 },
        ],
      }),
    ])
    expect(out).toContain('# Pull request #9 — existing review comments')
    expect(out).toContain('## Threads (2)')
    expect(out).toContain('### src/a.ts:10 — UNRESOLVED')
    expect(out).toContain('@octocat: This looks off.')
    expect(out).toContain('### src/b.ts:20 — RESOLVED')
    expect(out).toContain('@human (+1 reply): Handle the null case.')
  })

  it('renders a non-diff thread as "general" and a missing body gracefully', () => {
    const out = renderExistingReviewComments(1, [
      reviewThread({ path: null, line: null, comments: [] }),
    ])
    expect(out).toContain('### general — UNRESOLVED')
    expect(out).toContain('(no comment body)')
  })
})

describe('prReviewerExistingCommentsPreOp', () => {
  it('injects .cat-context/pr-existing-comments.md when the client lists review threads', async () => {
    const result = await prReviewerExistingCommentsPreOp(
      ctxWithThreads(async () => [reviewThread()], { prNumber: 12 }),
    )
    expect(result?.contextFiles).toHaveLength(1)
    expect(result?.contextFiles?.[0]?.path).toBe(PR_EXISTING_COMMENTS_CONTEXT_FILE)
    expect(result?.contextFiles?.[0]?.content).toContain('# Pull request #12 — existing review')
  })

  it('resolves the PR number from prUrl when prNumber is absent', async () => {
    let askedNumber = -1
    await prReviewerExistingCommentsPreOp(
      ctxWithThreads(
        async (n) => {
          askedNumber = n
          return [reviewThread()]
        },
        { prUrl: 'https://github.com/o/r/pull/321' },
      ),
    )
    expect(askedNumber).toBe(321)
  })

  it('passes through when the client can not read review threads', async () => {
    expect(
      await prReviewerExistingCommentsPreOp(ctxWithThreads(undefined, { prNumber: 12 })),
    ).toBeUndefined()
  })

  it('passes through when the PR number can not be resolved', async () => {
    let called = false
    await prReviewerExistingCommentsPreOp(
      ctxWithThreads(async () => {
        called = true
        return [reviewThread()]
      }, {}),
    )
    expect(called).toBe(false)
  })

  it('passes through when the PR has no review threads', async () => {
    expect(
      await prReviewerExistingCommentsPreOp(ctxWithThreads(async () => [], { prNumber: 12 })),
    ).toBeUndefined()
  })
})

describe('pr-reviewer kind registration', () => {
  it('registers the diff + existing-comments preOps on the built-in kind', () => {
    const ops = defaultAgentKindRegistry().preOps(PR_REVIEWER_KIND)
    expect(ops).toContain(prReviewerDiffPreOp)
    expect(ops).toContain(prReviewerExistingCommentsPreOp)
  })

  it('is code-aware so the review task’s selected best-practice fragments are folded', () => {
    // Without this trait `AgentContextBuilder.resolveFragments` drops the task's fragmentIds,
    // so the reviewer receives none and the "Provided context" snapshot records 0 fragments.
    expect(hasTrait(PR_REVIEWER_KIND, CODE_AWARE_TRAIT, defaultAgentKindRegistry())).toBe(true)
  })
})

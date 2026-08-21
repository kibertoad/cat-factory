import type {
  AgentRunContext,
  GitHubChangedFile,
  GitHubReviewThread,
  RepoFiles,
  RepoOpContext,
} from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, hasTrait } from './traits.js'
import { composeBlockSystemPrompt } from '../runtime/fragments.js'
import {
  MAX_PARALLEL_SLICE_SUBAGENTS,
  PR_DIFF_CONTEXT_FILE,
  PR_EXISTING_COMMENTS_CONTEXT_FILE,
  PR_PRIOR_REVIEW_CONTEXT_FILE,
  PR_REVIEWER_KIND,
  PR_REVIEWER_SYSTEM_PROMPT,
  planSlices,
  prReviewerDiffPreOp,
  prReviewerExistingCommentsPreOp,
  prReviewerStandardsPreOp,
  renderExistingReviewComments,
  renderPrDiffContext,
  renderPriorReviewContext,
  renderStandardContext,
  renderStandardsIndex,
  resolvePrHeadNumber,
  resolvePrNumber,
  standardsContextFileName,
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
  opts: { deliversCheckout?: boolean } = {},
): RepoOpContext {
  return {
    repo: { listChangedFiles } as unknown as RepoFiles,
    context: { block: { taskTypeFields } } as unknown as AgentRunContext,
    branch: 'main',
    opensPr: false,
    deliversCheckout: opts.deliversCheckout ?? true,
    logger: noopLogger,
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
    deliversCheckout: true,
    logger: noopLogger,
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

describe('resolvePrHeadNumber', () => {
  // WHICH pull request a `prHead` step prefetches is the KIND's declaration, and both readers of
  // that declaration (the run preamble's skip and the job body's prefetch) come through here, so
  // they cannot disagree about whether a step has anything to read.
  const block = {
    taskTypeFields: { prNumber: 4558 },
    pullRequest: { number: 12 },
  }

  it('reads the task declaration by default (the reviewer)', () => {
    expect(resolvePrHeadNumber({ branch: 'base', prHead: true }, block)).toBe(4558)
  })

  it('reads the run pull request when the kind declares `run` (the assessor)', () => {
    expect(resolvePrHeadNumber({ branch: 'base', prHead: true, prHeadSource: 'run' }, block)).toBe(
      12,
    )
  })

  it('never falls back across sources', () => {
    // The point of declaring it: a fallback silently widens whichever kind already had one source.
    expect(
      resolvePrHeadNumber(
        { branch: 'base', prHead: true, prHeadSource: 'run' },
        {
          taskTypeFields: { prNumber: 4558 },
        },
      ),
    ).toBeNull()
    expect(
      resolvePrHeadNumber({ branch: 'base', prHead: true }, { pullRequest: { number: 12 } }),
    ).toBeNull()
  })

  it('answers null for a step that fetches no head at all', () => {
    expect(resolvePrHeadNumber({ branch: 'base' }, block)).toBeNull()
    expect(resolvePrHeadNumber(undefined, block)).toBeNull()
  })
})

describe('planSlices', () => {
  it('groups by the leading path segments and orders by size', () => {
    const slices = planSlices([
      changedFile({ path: 'src/Auth/Login.cs', additions: 10, deletions: 0 }),
      changedFile({ path: 'src/Auth/Logout.cs', additions: 5, deletions: 0 }),
      changedFile({ path: 'src/Data/Repo.cs', additions: 100, deletions: 0 }),
      changedFile({ path: 'src/Data/Query.cs', additions: 50, deletions: 0 }),
    ])
    expect(slices.map((s) => s.title)).toEqual(['src/Data', 'src/Auth'])
    expect(slices[0]).toMatchObject({
      paths: ['src/Data/Query.cs', 'src/Data/Repo.cs'],
      changedLines: 150,
    })
  })

  it('collapses one-off groups into a shared "assorted" slice', () => {
    const slices = planSlices([
      changedFile({ path: 'README.md' }),
      changedFile({ path: 'tools/x/only.ts' }),
      changedFile({ path: 'src/App/A.cs' }),
      changedFile({ path: 'src/App/B.cs' }),
    ])
    expect(slices.map((s) => s.title).sort()).toEqual(['assorted', 'src/App'])
    const assorted = slices.find((s) => s.title === 'assorted')
    expect(assorted?.paths).toEqual(['README.md', 'tools/x/only.ts'])
  })

  it('splits an oversized group into numbered parts', () => {
    // 30 files in one area is over the 20-file slice cap.
    const files = Array.from({ length: 30 }, (_, i) =>
      changedFile({ path: `src/Big/f${i}.cs`, additions: 1, deletions: 0 }),
    )
    const titles = planSlices(files).map((s) => s.title)
    expect(titles).toContain('src/Big (part 1)')
    expect(titles).toContain('src/Big (part 2)')
    // Every file lands in exactly one part.
    const all = planSlices(files).flatMap((s) => s.paths)
    expect(new Set(all).size).toBe(30)
  })

  it('splits on changed lines even when the file count is small', () => {
    const files = Array.from({ length: 4 }, (_, i) =>
      changedFile({ path: `src/Big/f${i}.cs`, additions: 2000, deletions: 0 }),
    )
    expect(planSlices(files).length).toBeGreaterThan(1)
  })

  it('handles repo-root files', () => {
    const slices = planSlices([changedFile({ path: 'a.md' }), changedFile({ path: 'b.md' })])
    expect(slices[0]?.title).toBe('(repo root)')
  })
})

describe('renderPrDiffContext', () => {
  // The checkout-less shape. A consensus panel reviews this file as inline text with no
  // filesystem and no tools, so anything the container shape would have told it to fetch is
  // simply unreachable — the failure mode being pinned here is a panel that reviews a large PR
  // from its changed-file list while sounding as confident as one that read the diff.
  describe('without a checkout (a consensus panel)', () => {
    const bigDiff = () => {
      const big = '+x\n'.repeat(3400) // ~10 KiB each; 40 files is far over the container budget
      return Array.from({ length: 40 }, (_, i) => changedFile({ path: `src/f${i}.ts`, patch: big }))
    }

    it('never tells a reviewer with no git to read the diff from git', () => {
      const out = renderPrDiffContext(2, bigDiff(), { deliversCheckout: false })
      expect(out).not.toContain('git diff')
      expect(out).not.toContain('git show')
      expect(out).not.toContain('Patches — NOT inlined')
      // ... nor claim a checkout it does not have.
      expect(out).not.toContain('full base checkout')
      expect(out).toContain('no checkout')
    })

    it('inlines the patches a container render would have withheld', () => {
      const files = [changedFile({ path: 'src/a.ts', patch: '@@ +1 @@\n+alpha' }), ...bigDiff()]
      const out = renderPrDiffContext(2, files, { deliversCheckout: false })
      // Over the container all-or-nothing budget, so the container shape would inline nothing.
      expect(renderPrDiffContext(2, files, { deliversCheckout: true })).not.toContain('+alpha')
      expect(out).toContain('+alpha')
    })

    it('NAMES what did not fit instead of passing it off as reviewed', () => {
      // Far past even the inline-only budget, so some files cannot be included at all.
      const big = '+x\n'.repeat(10_000) // ~30 KiB each, under the per-file cap
      const files = Array.from({ length: 40 }, (_, i) =>
        changedFile({ path: `src/f${i}.ts`, patch: big }),
      )
      const out = renderPrDiffContext(2, files, { deliversCheckout: false })
      expect(out).toContain('Files whose diff is NOT available to you')
      expect(out).toContain('Do NOT infer')
      // Every file still appears in the changed-file list, so the panel knows the change is wider
      // than what it read rather than believing it saw all of it.
      for (let i = 0; i < 40; i++) expect(out).toContain(`src/f${i}.ts`)
    })

    it('is unchanged for a small PR, which fits either way', () => {
      const files = [changedFile({ path: 'src/a.ts', patch: '@@ +1 @@\n+kept' })]
      const out = renderPrDiffContext(7, files, { deliversCheckout: false })
      expect(out).toContain('+kept')
      expect(out).not.toContain('NOT available to you')
    })
  })

  it('lists every changed file, the change shape and a suggested slicing', () => {
    const out = renderPrDiffContext(
      9,
      [
        changedFile({ path: 'src/a.ts' }),
        changedFile({ path: 'src/b.ts', status: 'added', patch: '@@ +1 @@\n+hi' }),
      ],
      { deliversCheckout: true },
    )
    expect(out).toContain('# Pull request #9')
    expect(out).toContain('## Changed files (2)')
    expect(out).toContain('- modified src/a.ts (+3/-1)')
    expect(out).toContain('- added src/b.ts')
    expect(out).toContain('## Change shape')
    expect(out).toContain('## Suggested slicing')
  })

  it('inlines every patch when the whole diff is small enough for one pass', () => {
    const out = renderPrDiffContext(
      9,
      [
        changedFile({ path: 'src/a.ts' }),
        changedFile({ path: 'src/b.ts', status: 'added', patch: '@@ +1 @@\n+hi' }),
      ],
      { deliversCheckout: true },
    )
    expect(out).toContain('## Patches')
    expect(out).toContain('+new')
    expect(out).toContain('+hi')
  })

  it('notes a rename and a null (binary/oversized) patch instead of a diff block', () => {
    const out = renderPrDiffContext(
      1,
      [changedFile({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', patch: null })],
      { deliversCheckout: true },
    )
    expect(out).toContain('(renamed from old.ts)')
    expect(out).toContain('(no patch — binary or too large; read the file from the checkout)')
  })

  // The measured failure this replaces: a 319 KB partially-inlined diff sat in the reviewer's
  // context for all 96 of its turns while the slice subagents ran 141 git calls and referenced
  // it once. Past the budget the file is a MAP, and the diffs are read per slice.
  it('inlines no patch at all once the diff is too large to review in one pass', () => {
    const big = '+x\n'.repeat(3400) // ~10 KiB each; 40 files is far over the 64 KiB budget
    const files = Array.from({ length: 40 }, (_, i) =>
      changedFile({ path: `src/f${i}.ts`, patch: big }),
    )
    const out = renderPrDiffContext(2, files, { deliversCheckout: true })
    // Every file is still listed (the cheap slicing signal is never dropped) ...
    expect(out).toContain('## Changed files (40)')
    for (let i = 0; i < 40; i++) expect(out).toContain(`src/f${i}.ts`)
    // ... and the suggested slicing still computed ...
    expect(out).toContain('## Suggested slicing')
    // ... but not one patch is inlined.
    expect(out).not.toContain(big)
    expect(out).toContain('Patches — NOT inlined')
    expect(out).toContain('git diff origin/<base>...origin/pr-head')
  })

  it('does not let one oversized patch push a small PR onto the manifest-only path', () => {
    // A ~40 KiB generated-file patch is over the 32 KiB per-file cap: it is stubbed and left OUT
    // of the inline decision, so the small patch beside it is still inlined.
    const huge = '+x\n'.repeat(20000) // ~40 KiB
    const out = renderPrDiffContext(
      3,
      [
        changedFile({ path: 'pnpm-lock.yaml', patch: huge }),
        changedFile({ path: 'src/small.ts', patch: '@@ +1 @@\n+kept' }),
      ],
      { deliversCheckout: true },
    )
    expect(out).toContain('over the per-file inline budget')
    expect(out).not.toContain(huge)
    expect(out).toContain('+kept')
  })

  // A provider that cannot report a file's line counts (GitLab withholds the hunk for an
  // oversized diff, so there is nothing to count off) must not have that rendered as `+0/-0`.
  // The reviewer acts on these badges: `+0/-0` beside "no patch" describes a file nobody
  // touched, which is precisely the file it would then skip.
  it('says the size is unreported rather than rendering an unknown count as zero', () => {
    const out = renderPrDiffContext(
      4,
      [
        changedFile({ path: 'src/huge.ts', additions: null, deletions: null, patch: null }),
        changedFile({ path: 'assets/logo.png', additions: 0, deletions: 0, patch: null }),
      ],
      { deliversCheckout: true },
    )
    expect(out).toContain('size not reported by the host')
    // A real zero (a binary file, which neither host can line-count) still renders as one, or
    // the distinction would be lost in the other direction.
    expect(out).toContain('+0/-0')
  })

  it('sizes a slice off the counts it has, without letting an unreported file dominate', () => {
    // An unreported file carries no patch, so it costs the slice nothing to include — the
    // budget is rationing the reviewer's context, not the change's true size.
    const slices = planSlices([
      changedFile({ path: 'src/a.ts', additions: null, deletions: null, patch: null }),
      changedFile({ path: 'src/b.ts', additions: 3, deletions: 1 }),
    ])
    expect(slices[0]?.changedLines).toBe(4)
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

  // De-dup is a per-slice concern. The parent reading this whole file was the single biggest
  // carried item of the measured run (7,957 tokens × 75 remaining turns ≈ 597k), so the file is
  // grouped under a path index a slice reviewer can grep for its own paths.
  it('groups threads by file under a path index a slice reviewer can grep', () => {
    const out = renderExistingReviewComments(9, [
      reviewThread({ path: 'src/a.ts', line: 10 }),
      reviewThread({ id: 'T2', path: 'src/b.ts', line: 20 }),
      reviewThread({ id: 'T3', path: 'src/a.ts', line: 30 }),
    ])
    expect(out).toContain('## Files with existing threads (2)')
    expect(out).toContain('- src/a.ts (2 thread(s))')
    expect(out).toContain('- src/b.ts (1 thread(s))')
    expect(out).toContain('## src/a.ts')
    expect(out).toContain('grep -n -A2')
    // Both of src/a.ts's threads sit under its one group heading, before src/b.ts's.
    expect(out.indexOf('### src/a.ts:30')).toBeLessThan(out.indexOf('## src/b.ts'))
  })

  it('renders a non-diff thread as "general" and a missing body gracefully', () => {
    const out = renderExistingReviewComments(1, [
      reviewThread({ path: null, line: null, comments: [] }),
    ])
    expect(out).toContain('### general — UNRESOLVED')
    expect(out).toContain('(no comment body)')
  })
})

describe('standards as context files', () => {
  const fragment = (id: string, title?: string) => ({ id, title, body: `body of ${id}` })

  it('names each file so it survives the harness context-file sanitizer verbatim', () => {
    // An already-safe id keeps a clean, readable filename (no hash suffix).
    expect(standardsContextFileName('idiomatic-csharp')).toBe('standard-idiomatic-csharp.md')
    // The harness keeps only [A-Za-z0-9._-] and flattens directories, so the name generated
    // here must already be in that alphabet or the prompt would point at a file that isn't there.
    const name = standardsContextFileName('org/team scoped:standard')
    expect(name).toMatch(/^standard-org-team-scoped-standard-[a-z0-9]+\.md$/)
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('disambiguates two ids that sanitize to the same slug (else the harness drops one)', () => {
    // `org/team` and `org team` both sanitize to `org-team`; the harness dedupes by path, so
    // without the hash suffix the second standard would silently vanish from the injected set.
    const a = standardsContextFileName('org/team')
    const b = standardsContextFileName('org team')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^standard-org-team-[a-z0-9]+\.md$/)
  })

  it('renders one file per standard with its citable title', () => {
    const out = renderStandardContext(fragment('idiomatic-csharp', 'Writing Idiomatic C#'))
    expect(out).toContain('# Writing Idiomatic C#')
    expect(out).toContain('body of idiomatic-csharp')
    expect(out).toContain('`idiomatic-csharp`')
  })

  it('indexes every standard with the path the agent must read', () => {
    const out = renderStandardsIndex([fragment('a', 'Alpha'), fragment('b')])
    expect(out).toContain('`.cat-context/standard-a.md`')
    expect(out).toContain('`.cat-context/standard-b.md`')
    expect(out).toContain('**Alpha**')
    // The paraphrase ban is the point: fragmentAdherence must come from the real text.
    expect(out).toContain('Do NOT paraphrase')
  })

  /** A standard past the section-map threshold, with `sections` headings and padded bodies. */
  const bigFragment = (id: string, sections: number) => ({
    id,
    title: id,
    body: Array.from(
      { length: sections },
      (_, i) => `## Section ${i}\n\n${`${'padding text '.repeat(6)}\n`.repeat(40)}`,
    ).join('\n'),
  })

  it('gives a large standard a section map whose line ranges land on its headings', () => {
    // Reading a 40 KB standard whole is what a slice then re-sends on all of its turns. The map
    // is what lets the parent route a slice to the part that applies.
    const big = bigFragment('perf', 4)
    const out = renderStandardsIndex([big])
    expect(out).toContain('Section 0 — lines ')

    // The ranges must be resolvable against the FILE the agent opens, not the raw body.
    const lines = renderStandardContext(big).split('\n')
    const [, from, to] = /Section 2 — lines (\d+)-(\d+)/.exec(out) ?? []
    expect(lines[Number(from) - 1]).toBe('## Section 2')
    // The range ends where the next section begins, so it carries that section and no other.
    expect(lines.slice(Number(from) - 1, Number(to)).join('\n')).not.toContain('## Section 3')
  })

  it('leaves a small standard mapless — probing it costs more than reading it', () => {
    const out = renderStandardsIndex([fragment('tiny', 'Tiny')])
    expect(out).toContain('**Tiny**')
    expect(out).not.toContain('lines ')
    expect(out).not.toContain('read the sections that apply')
  })

  it('ignores headings inside fenced code, which are examples and not sections', () => {
    const withFence = {
      id: 'fenced',
      title: 'Fenced',
      body: `## Real\n\n${`${'x'.repeat(60)}\n`.repeat(80)}\n\`\`\`md\n## Not A Section\n\`\`\`\n${`${'y'.repeat(60)}\n`.repeat(80)}`,
    }
    const out = renderStandardsIndex([withFence])
    expect(out).toContain('Real — lines ')
    expect(out).not.toContain('Not A Section')
  })

  it('caps the section map, so a heavily-subdivided standard cannot become the cost itself', () => {
    const out = renderStandardsIndex([bigFragment('many', 30)])
    expect(out).toContain('Section 15 — lines ')
    expect(out).not.toContain('Section 16 — lines ')
    expect(out).toContain('…and 14 more section(s)')
  })

  it('writes an index plus one file per resolved fragment', async () => {
    const result = await prReviewerStandardsPreOp({
      repo: {} as unknown as RepoFiles,
      context: {
        block: { resolvedFragments: [fragment('a', 'Alpha'), fragment('b', 'Beta')] },
      } as unknown as AgentRunContext,
      branch: 'main',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
    })
    expect(result?.contextFiles?.map((f) => f.path)).toEqual([
      'standards.md',
      'standard-a.md',
      'standard-b.md',
    ])
  })

  it('passes through when the run resolved no fragments', async () => {
    expect(
      await prReviewerStandardsPreOp({
        repo: {} as unknown as RepoFiles,
        context: { block: {} } as unknown as AgentRunContext,
        branch: 'main',
        opensPr: false,
        deliversCheckout: true,
        logger: noopLogger,
      }),
    ).toBeUndefined()
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

describe('slice dispatch guidance', () => {
  // This block is rewritten by roughly every turn-reduction slice, and two of its rules are
  // load-bearing OUTSIDE the prompt: the in-flight cap is the only thing standing between a
  // large PR and a rate-limited fan-out, and the dispatch DESCRIPTION is what `SliceTracker`
  // matches against the parent's task entries to render one progress row per slice. Neither
  // has a runtime guard (the CLI owns tool dispatch), so a rewrite that drops one is invisible
  // until a review misbehaves in production. Pin them here.

  it('caps the slices in flight, and states the cap as the shared constant', () => {
    expect(MAX_PARALLEL_SLICE_SUBAGENTS).toBeGreaterThan(0)
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain(
      `keep AT MOST ${MAX_PARALLEL_SLICE_SUBAGENTS} in flight`,
    )
    // The cap only holds if the reviewer refills as slices return, rather than stopping at one wave.
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('dispatch the next')
  })

  it('requires the window to be filled in ONE response — the cap is not a licence to serialise', () => {
    // The measured run dispatched slice 1 alone and let it run ~70 turns to completion before
    // slices 2-4 went out. Capping concurrency and filling the window at once are complementary;
    // a rewrite that reads the cap as "one at a time" reintroduces that.
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('parallel tool calls in ONE response')
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('never one at a time')
  })

  it('keeps the dispatch-description contract SliceTracker matches slices by name on', () => {
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('Review <slice short name> slice')
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain("mark a slice's task entry in progress")
  })

  it('gives each slice a turn budget, since ProgressGuard cannot see a productive overrun', () => {
    // A slice grinding through a 16-line change for 40 turns trips nothing: it is making
    // progress, just not progress worth its carry.
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('TURN BUDGET')
  })

  it('tells a RESUMED run to read the prior-review file and fold its findings in', () => {
    // The engine drops the captured reports once an aggregation lands, so a resumed reviewer that
    // ignores this file throws away the work the resume existed to save. The filename is named
    // exactly, because the file's presence is the only signal that this is a resume.
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain(`.cat-context/${PR_PRIOR_REVIEW_CONTEXT_FILE}`)
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('RESUMED run')
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('Review ONLY the remaining slices')
    // And that it still owes a task list, or the window loses its per-slice progress on a resume.
    expect(PR_REVIEWER_SYSTEM_PROMPT).toContain('Still record a task list')
  })
})

describe('renderPriorReviewContext', () => {
  const slice = (label: string, status: 'in_progress' | 'completed', report?: string | null) => ({
    label,
    status,
    report: report ?? null,
  })

  it('carries each finished report verbatim and names only the remaining slices', () => {
    // This IS the feature: the resumed reviewer must be able to aggregate the earlier findings
    // without re-reviewing the slices that produced them.
    const out = renderPriorReviewContext(
      [slice('api', 'completed', 'Found an N+1 in listUsers.'), slice('infra', 'in_progress')],
      ['infra'],
    )
    expect(out).toContain('Found an N+1 in listUsers.')
    expect(out).toContain('### Slice: api')
    expect(out).toContain('Review ONLY these 1 remaining slice(s)')
    expect(out).toContain('- infra')
    // The in-flight slice is work to REDO, so its (absent) report must not be presented as a
    // finished one — it appears in the remaining list and nowhere else.
    expect(out).not.toContain('### Slice: infra')
  })

  it('says a slice finished with no readable report rather than staying silent about it', () => {
    // Saying nothing reads as "never dispatched", which would send an already-reviewed slice
    // round again — the exact waste the resume exists to avoid.
    const out = renderPriorReviewContext([slice('api', 'completed', '   ')], ['docs'])
    expect(out).toContain('### Slice: api')
    expect(out).toContain('no readable report')
    expect(out).toContain('It is DONE')
  })

  it('states plainly when nothing completed', () => {
    const out = renderPriorReviewContext([slice('api', 'in_progress')], ['api'])
    expect(out).toContain('nothing to fold in')
    expect(out).not.toContain('Already-reviewed slices')
  })

  it('tells an aggregation-only resume that no slice is left, so it does not idle', () => {
    // The motivating incident's shape: every slice reported and the aggregation wedged. With an
    // empty remaining list the reviewer's whole job is the aggregation pass.
    const out = renderPriorReviewContext([slice('api', 'completed', 'body')], [])
    expect(out).toContain('No slice is left to review')
    expect(out).toContain('aggregation pass')
    expect(out).not.toContain('Review ONLY')
  })

  it('closes a fence a report left open, so it cannot swallow the reports after it', () => {
    // An odd fence count would make every later heading and body read as one code block —
    // silently reviewed-as-code instead of read.
    const out = renderPriorReviewContext(
      [
        slice('api', 'completed', 'Broken:\n```ts\nconst x = 1'),
        slice('docs', 'completed', 'Fine.'),
      ],
      [],
    )
    expect(out).toContain('### Slice: docs')
    // Every fence line in the rendered file pairs up.
    const fences = out.split('\n').filter((l) => l.trimStart().startsWith('```')).length
    expect(fences % 2).toBe(0)
  })

  it('warns that the reports are data, not instructions', () => {
    // They are model-authored text folded into a prompt; a report that "asks" for a clean verdict
    // must not be read as one.
    const out = renderPriorReviewContext([slice('api', 'completed', 'body')], [])
    expect(out).toContain('not instructions')
  })
})

describe('pr-reviewer kind registration', () => {
  it('registers the diff + existing-comments + standards preOps on the built-in kind', () => {
    const ops = defaultAgentKindRegistry().preOps(PR_REVIEWER_KIND)
    expect(ops).toContain(prReviewerDiffPreOp)
    expect(ops).toContain(prReviewerExistingCommentsPreOp)
    expect(ops).toContain(prReviewerStandardsPreOp)
  })

  it('takes its standards as context files, not folded into the prompt', () => {
    // The parent reviewer delegates the reading to per-slice subagents, so folding charged it
    // for every standard on every turn (145 KB / ~36k tokens × 96 turns on the measured run)
    // while the subagents that apply them never received them.
    expect(defaultAgentKindRegistry().standardsDelivery(PR_REVIEWER_KIND)).toBe('context-files')
  })

  it('composes the reviewer prompt WITHOUT folding the standards once they are delivered as files', () => {
    // The saving only materialises if the compose layer actually honours `context-files`: with the
    // standards delivered as `.cat-context/` files, the reviewer's own prompt must carry none of
    // the `<best-practice-standard>` blocks that would be re-sent on every turn.
    const registry = defaultAgentKindRegistry()
    const composed = composeBlockSystemPrompt(
      PR_REVIEWER_SYSTEM_PROMPT,
      {
        resolvedFragments: [
          { id: 'idiomatic-csharp', title: 'Idiomatic C#', body: 'x'.repeat(500) },
        ],
      },
      registry.standardsDelivery(PR_REVIEWER_KIND),
      true, // standards delivered as files
    )
    expect(composed).toBe(PR_REVIEWER_SYSTEM_PROMPT)
    // A folded standard is an OPENING TAG carrying the fragment's id, not the mere mention of the
    // element: the adherence guidance names it, because the fold is the run's other possible
    // channel and the reviewer has to recognise a block if it sees one.
    expect(composed).not.toContain('<best-practice-standard id=')
    // ...and the adherence guidance names the file channel as the one this run used. It names the
    // prompt channel too, because the fold is only suppressed once the files actually landed: the
    // `standardsDelivered: false` fallback folds them in, and telling the reviewer they are "NOT in
    // this prompt" was false on exactly that run.
    expect(composed).toContain('.cat-context/standards.md')
  })

  it('requests the PR-head prefetch (clone.prHead) so the engine resolves reviewPrNumber', () => {
    // Without this the review clones only the base branch and — the container agent holding no git
    // credential — the head version of modified files and every ADDED file are unreachable.
    const spec = defaultAgentKindRegistry().agentStep(PR_REVIEWER_KIND)
    expect(spec?.clone?.prHead).toBe(true)
    expect(spec?.clone?.full).toBe(true)
  })

  it('is code-aware so the review task’s selected best-practice fragments are folded', () => {
    // Without this trait `AgentContextBuilder.resolveFragments` drops the task's fragmentIds,
    // so the reviewer receives none and the "Provided context" snapshot records 0 fragments.
    expect(hasTrait(PR_REVIEWER_KIND, CODE_AWARE_TRAIT, defaultAgentKindRegistry())).toBe(true)
  })
})

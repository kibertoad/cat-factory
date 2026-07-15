import type { CommitFilesInput, OpenPullRequestInput } from '@cat-factory/contracts'
import type { AgentRunContext, RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../catalog.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import { READ_ONLY_GUARDRAIL, isReadOnlyAgentKind } from './read-only.js'
import { defaultAgentKindRegistry } from './registry.js'
import {
  SPIKE_AGENT_KIND,
  renderSpikeFindings,
  spikeContextSection,
  spikeFindings,
  spikePostOp,
} from './spike.js'

// `defaultAgentKindRegistry()` pre-loads the built-in spike kind, so a fresh instance exposes
// it (no module-global side effect).
const registry = defaultAgentKindRegistry()

/**
 * A tiny in-memory, BRANCH-AWARE RepoFiles that APPLIES commits + tracks branches and opened
 * PRs, so both the direct-commit idempotency and the PR-delivery flow can be tested end-to-end.
 * `main` exists from the start (a non-empty repo); other branches appear via `createBranch`.
 */
class FakeRepo implements RepoFiles {
  readonly commits: CommitFilesInput[] = []
  readonly opened: OpenPullRequestInput[] = []
  private readonly branches = new Set<string>(['main'])
  constructor(private readonly files: Map<string, string> = new Map()) {}

  async getFile(path: string) {
    const content = this.files.get(`${path}`)
    return content === undefined ? null : { content, sha: 'sha' }
  }
  async listDirectory(): Promise<RepoContentEntry[]> {
    return []
  }
  async headSha(branch: string) {
    return this.branches.has(branch) ? `${branch}-sha` : null
  }
  async createBranch(branch: string) {
    this.branches.add(branch)
  }
  async deleteBranch() {}
  async commitFiles(input: CommitFilesInput) {
    this.commits.push(input)
    this.branches.add(input.branch)
    for (const f of input.files) this.files.set(f.path, f.content)
    return { sha: 'commit' }
  }
  async openPullRequest(input: OpenPullRequestInput) {
    this.opened.push(input)
    return {
      repoGithubId: 1,
      number: 7,
      githubId: 700,
      title: input.title,
      state: 'open' as const,
      headRef: input.head,
      baseRef: input.base,
      headSha: null,
      merged: false,
      author: 'bot',
      updatedAt: 0,
      syncedAt: 0,
      url: 'https://github.test/acme/repo/pull/7',
    }
  }
}

/** A RepoFiles whose write always fails — stands in for a protected base branch / missing push. */
class RejectingRepo extends FakeRepo {
  override async commitFiles(): Promise<never> {
    throw new Error('refusing to allow a non-fast-forward push to a protected branch')
  }
}

const WELL_FORMED = {
  question: 'Should we adopt library X?',
  summary: 'X fits our needs with one caveat around bundle size.',
  findings: [{ title: 'Good DX', detail: 'Typed API, small surface.' }],
  optionsCompared: [{ option: 'X', assessment: 'Best fit' }],
  recommendation: 'Adopt X behind a flag.',
  openQuestions: ['Bundle-size budget?'],
  confidence: 0.7,
}

const ctx = (
  repo: RepoFiles,
  custom: unknown,
  opts: { opensPr?: boolean; title?: string; taskTypeFields?: Record<string, unknown> } = {},
) => ({
  repo,
  branch: 'main',
  opensPr: opts.opensPr ?? false,
  context: {
    agentKind: SPIKE_AGENT_KIND,
    block: {
      id: 'task_login',
      title: opts.title ?? 'Adopt X',
      taskTypeFields: opts.taskTypeFields,
    },
  } as unknown as AgentRunContext,
  result: { output: '', custom },
})

describe('spike agent kind', () => {
  it('registers a read-only container-explore kind that clones base + opens the generic view', () => {
    const step = registry.agentStep(SPIKE_AGENT_KIND)
    expect(step?.surface).toBe('container-explore')
    // Reads the repo AS-IS (base branch); the findings commit is the backend post-op, not the
    // container — so the read-only contract holds.
    expect(step?.clone?.branch).toBe('base')
    expect(registry.requiresContainer(SPIKE_AGENT_KIND)).toBe(true)
    expect(isReadOnlyAgentKind(SPIKE_AGENT_KIND)).toBe(true)
    expect(registry.presentation(SPIKE_AGENT_KIND)?.resultView).toBe('generic-structured')
  })

  it('fails loudly on an unusable final answer — the findings ARE the deliverable', () => {
    expect(spikeFindings.spec.failOnUnusableFinal).toBe(true)
  })

  it('appends the read-only guardrail + final-answer-in-reply surface directives', () => {
    const prompt = systemPromptFor(SPIKE_AGENT_KIND, registry)
    expect(prompt).toContain(READ_ONLY_GUARDRAIL)
    expect(prompt).toContain(FINAL_ANSWER_IN_REPLY)
    expect(prompt).toContain('TIMEBOXED SPIKE')
  })

  describe('renderSpikeFindings', () => {
    it('renders every populated section deterministically', () => {
      const md = renderSpikeFindings(spikeFindings.parse(WELL_FORMED), 'Adopt X')
      expect(md).toContain('# Spike: Adopt X')
      expect(md).toContain('## Recommendation\n\nAdopt X behind a flag.')
      expect(md).toContain('_Confidence: 70%_')
      expect(md).toContain('- **Good DX**')
      // Pure: the same input renders byte-identical output.
      expect(renderSpikeFindings(spikeFindings.parse(WELL_FORMED), 'Adopt X')).toBe(md)
    })
  })

  describe('spikePostOp', () => {
    it('renders + commits the findings to docs/research on the base branch', async () => {
      const repo = new FakeRepo()
      await spikePostOp(ctx(repo, WELL_FORMED))
      expect(repo.commits).toHaveLength(1)
      expect(repo.commits[0]?.branch).toBe('main')
      expect(repo.commits[0]?.files[0]?.path).toBe('docs/research/adopt-x.md')
      expect(repo.commits[0]?.files[0]?.content).toContain('Adopt X behind a flag.')
    })

    it('honours a pinned targetPath over the slug fallback', async () => {
      const repo = new FakeRepo()
      await spikePostOp(ctx(repo, WELL_FORMED, { taskTypeFields: { targetPath: 'docs/x.md' } }))
      expect(repo.commits[0]?.files[0]?.path).toBe('docs/x.md')
    })

    it('is idempotent — a replay over an unchanged tree commits nothing', async () => {
      const repo = new FakeRepo()
      await spikePostOp(ctx(repo, WELL_FORMED))
      await spikePostOp(ctx(repo, WELL_FORMED))
      expect(repo.commits).toHaveLength(1)
    })

    it('commits nothing when the result is absent or a present-but-empty object', async () => {
      const repo = new FakeRepo()
      await spikePostOp(ctx(repo, undefined))
      await spikePostOp(ctx(repo, {}))
      expect(repo.commits).toHaveLength(0)
    })

    it('is best-effort: a rejected write leaves the run intact (findings live on step.custom)', async () => {
      const repo = new RejectingRepo()
      // Must NOT throw — a protected branch / missing push permission cannot discard an
      // otherwise-successful investigation whose findings already settled on the step.
      await expect(spikePostOp(ctx(repo, WELL_FORMED))).resolves.toBeUndefined()
    })

    it('PR mode: commits to a work branch and opens a PR, returning its ref', async () => {
      const repo = new FakeRepo()
      const out = await spikePostOp(ctx(repo, WELL_FORMED, { opensPr: true }))
      // Committed to the per-block work branch (not base), then PR'd onto base.
      expect(repo.commits).toHaveLength(1)
      expect(repo.commits[0]?.branch).toBe('cat-factory/task_login')
      expect(repo.opened).toHaveLength(1)
      expect(repo.opened[0]).toMatchObject({ head: 'cat-factory/task_login', base: 'main' })
      // The opened PR is returned so the engine records it as `block.pullRequest`.
      expect(out).toEqual({
        pullRequest: {
          url: 'https://github.test/acme/repo/pull/7',
          number: 7,
          branch: 'cat-factory/task_login',
        },
      })
    })

    it('PR mode: a failed open PROPAGATES (the PR is the whole point — not best-effort)', async () => {
      const repo = new RejectingRepo()
      await expect(spikePostOp(ctx(repo, WELL_FORMED, { opensPr: true }))).rejects.toThrow()
    })
  })

  describe('spikeContextSection', () => {
    it('folds the time-box + research criteria into a prompt section', () => {
      const section = spikeContextSection({
        block: {
          taskTypeFields: {
            timeboxHours: 4,
            researchQuestion: 'Adopt X?',
            successCriteria: 'A go/no-go call',
            optionsToCompare: 'X vs Y',
          },
        },
      } as unknown as AgentRunContext)
      expect(section).toContain('Time-box: ~4 hour(s)')
      expect(section).toContain('Research question: Adopt X?')
      expect(section).toContain('Success criteria / decision sought: A go/no-go call')
      expect(section).toContain('Options to compare: X vs Y')
    })

    it('returns undefined when the spike carries no parameters (additive section)', () => {
      expect(spikeContextSection({ block: {} } as unknown as AgentRunContext)).toBeUndefined()
    })
  })
})

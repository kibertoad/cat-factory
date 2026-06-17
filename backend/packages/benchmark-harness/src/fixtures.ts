import type { AgentRunContext, BlockType } from '@cat-factory/core'
import { requirementsLogic } from '@cat-factory/core'
import type { RepoSpec } from '@cat-factory/implementer-harness/embed'

// Task fixtures: the inputs each benchmarked agent reasons over. Hand-authored
// and committed with the package so runs are reproducible; add more cases by
// appending to the relevant array. They are deliberately small but contain real
// ambiguity / a real bug / a real build task so the arbiter has something to
// grade.

export interface RequirementReviewFixture {
  id: string
  title: string
  context: requirementsLogic.RequirementsContext
}

export interface CodeReviewFixture {
  id: string
  title: string
  /** A ready-to-run reviewer context; `priorOutputs` carries the work to review. */
  context: AgentRunContext
}

export interface ImplementationFixture {
  id: string
  title: string
  repo: RepoSpec
  /** Block context for the build system prompt. */
  block: { title: string; type: BlockType; description: string; features?: string[] }
  /** The concrete task handed to Pi. */
  task: string
}

export const REQUIREMENT_REVIEW_FIXTURES: RequirementReviewFixture[] = [
  {
    id: 'password-reset',
    title: 'Password reset flow',
    context: {
      block: {
        title: 'Password reset',
        type: 'service' as BlockType,
        description:
          'Let users reset their password. Send them a link by email and let them set a new password.',
        features: ['Request reset link', 'Set new password'],
      },
      docs: [],
      tasks: [],
    },
  },
]

export const CODE_REVIEW_FIXTURES: CodeReviewFixture[] = [
  {
    id: 'token-bucket',
    title: 'Rate limiter implementation',
    context: {
      agentKind: 'reviewer',
      pipelineName: 'benchmark',
      stepIndex: 1,
      isFinalStep: true,
      block: {
        title: 'Per-IP rate limiter',
        type: 'api' as BlockType,
        description: 'A token-bucket rate limiter middleware that allows 100 requests/minute per IP.',
      },
      priorOutputs: [
        {
          agentKind: 'coder',
          output: [
            'Implemented the limiter:',
            '',
            '```ts',
            'const buckets = new Map<string, number>()',
            '',
            'export function allow(ip: string): boolean {',
            '  const count = buckets.get(ip) ?? 0',
            '  if (count >= 100) return false',
            '  buckets.set(ip, count + 1)',
            '  return true',
            '}',
            '```',
            '',
            'The counter increments on each request and rejects once it hits 100.',
          ].join('\n'),
        },
      ],
      decisions: [],
      resolvedDecision: null,
    },
  },
]

export const IMPLEMENTATION_FIXTURES: ImplementationFixture[] = [
  {
    id: 'hello-contributing',
    title: 'Add a CONTRIBUTING.md',
    repo: {
      owner: 'octocat',
      name: 'Hello-World',
      baseBranch: 'master',
      cloneUrl: 'https://github.com/octocat/Hello-World.git',
    },
    block: {
      title: 'Contributor guide',
      type: 'service' as BlockType,
      description: 'The repo has no contributor guidance.',
    },
    task: 'Add a concise CONTRIBUTING.md explaining how to open issues and submit pull requests for this project.',
  },
]

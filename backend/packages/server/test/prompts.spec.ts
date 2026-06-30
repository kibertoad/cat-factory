import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { RepoTarget } from '../src/agents/ContainerAgentExecutor.js'
import {
  blueprintUserPrompt,
  mergerUserPrompt,
  onCallUserPrompt,
  prBody,
  specWriterUserPrompt,
  TEST_REPORT_SHAPE_HINT,
  testerInfraSpec,
  UI_TEST_REPORT_SHAPE_HINT,
} from '../src/agents/prompts.js'

// Characterisation tests pinning the per-kind prompt material that was extracted verbatim
// from ContainerAgentExecutor.ts into prompts.ts. They lock in the deterministic prompt
// shapes + the infra-spec branches so the move is provably behaviour-preserving.

const repo: RepoTarget = {
  installationId: 1,
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}

const context = (over: Record<string, unknown> = {}): AgentRunContext =>
  ({
    agentKind: 'on-call',
    pipelineName: 'Ship',
    block: { id: 'b1', title: 'Add login', type: 'task' },
    decisions: [],
    priorOutputs: [],
    ...over,
  }) as unknown as AgentRunContext

describe('blueprintUserPrompt', () => {
  it('instructs an update-or-create that returns the complete tree as JSON only', () => {
    const p = blueprintUserPrompt()
    expect(p).toContain('canonical service → modules blueprint')
    expect(p).toContain('blueprints/blueprint.json')
    expect(p).toContain('ONLY the JSON object')
  })
})

describe('specWriterUserPrompt', () => {
  it('embeds the block header + description and the default self-determine guidance', () => {
    const p = specWriterUserPrompt(
      context({
        block: { id: 'b9', title: 'Refactor auth', type: 'task', description: 'Tidy it' },
      }),
    )
    expect(p).toContain('### Refactor auth (block b9)')
    expect(p).toContain('Tidy it')
    expect(p).toContain('If this task is purely TECHNICAL')
  })

  it('withdraws the no-specs escape hatch for an explicit BUSINESS task', () => {
    const p = specWriterUserPrompt(
      context({ block: { id: 'b1', title: 'T', type: 'task', technical: false } }),
    )
    expect(p).toContain('explicitly flagged BUSINESS')
    expect(p).not.toContain('If this task is purely TECHNICAL')
  })

  it('tells an explicit TECHNICAL task the empty outcome is expected', () => {
    const p = specWriterUserPrompt(
      context({ block: { id: 'b1', title: 'T', type: 'task', technical: true } }),
    )
    expect(p).toContain('explicitly flagged TECHNICAL')
    expect(p).toContain('{"noBusinessSpecs": true}')
  })
})

describe('mergerUserPrompt', () => {
  it('names the PR + branches so the agent diffs against the right base', () => {
    const p = mergerUserPrompt(
      context({
        block: {
          id: 'b1',
          title: 'T',
          type: 'task',
          pullRequest: { number: 42, branch: 'feat/x', url: 'u' },
        },
      }),
      repo,
    )
    expect(p).toContain('(PR #42)')
    expect(p).toContain('`feat/x`')
    expect(p).toContain('git diff origin/main...HEAD')
  })

  it('falls back to the base branch when there is no PR', () => {
    const p = mergerUserPrompt(context({ block: { id: 'b1', title: 'T', type: 'task' } }), repo)
    expect(p).toContain('`main`')
    expect(p).not.toContain('(PR #')
  })
})

describe('onCallUserPrompt', () => {
  it('tells the agent how to locate the merged commit by PR number', () => {
    const p = onCallUserPrompt(
      context({
        block: {
          id: 'b1',
          title: 'T',
          type: 'task',
          pullRequest: { number: 7, branch: 'feat/y', url: 'u' },
        },
      }),
      repo,
    )
    expect(p).toContain('#7')
    expect(p).toContain('git log --oneline -n 50')
    expect(p).toContain('base branch `main`')
  })
})

describe('testerInfraSpec', () => {
  it('carries the docker-compose path for a local run', () => {
    const spec = testerInfraSpec(
      context({
        block: {
          id: 'b1',
          title: 'T',
          type: 'task',
          agentConfig: { 'tester.environment': 'local' },
        },
        service: { testComposePath: 'docker-compose.yml' },
      } as Record<string, unknown>),
    )
    expect(spec).toMatchObject({
      environment: 'local',
      noInfraDependencies: false,
      composePath: 'docker-compose.yml',
    })
  })

  it('carries the provisioned environment URL for an ephemeral run', () => {
    const spec = testerInfraSpec(
      context({ environment: { url: 'https://env.example' } } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'ephemeral', environmentUrl: 'https://env.example' })
  })
})

describe('prBody', () => {
  it('renders the block title/type, description and pipeline name', () => {
    const body = prBody(
      context({ block: { id: 'b1', title: 'Add login', type: 'task', description: 'do it' } }),
    )
    expect(body).toContain('**Add login** (task)')
    expect(body).toContain('do it')
    expect(body).toContain('Pipeline: Ship')
  })
})

describe('UI_TEST_REPORT_SHAPE_HINT', () => {
  it('extends the base tester report with a screenshots array', () => {
    expect(UI_TEST_REPORT_SHAPE_HINT).toContain('"screenshots"')
    // Derived from the base hint, so it preserves its leading shape.
    expect(UI_TEST_REPORT_SHAPE_HINT.startsWith(TEST_REPORT_SHAPE_HINT.replace(/\}\.$/, ''))).toBe(
      true,
    )
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentDispatchContext, AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'
import { CONFLICT_RESOLVER_AGENT_KIND, ON_CALL_AGENT_KIND } from '@cat-factory/kernel'
import { MERGER_AGENT_KIND } from '../kinds/built-in-container.js'
import {
  mergerUserPrompt,
  TEST_REPORT_SHAPE_HINT,
  UI_TEST_REPORT_SHAPE_HINT,
} from './built-in-container.js'

// The task prompts for the assessment + resolver built-ins. They moved here from the HTTP layer
// when those kinds became real registry entries, and these tests moved with them: the same
// assertions, now driven through `userPromptFor` (the seam a registered kind's prompt actually
// resolves through) rather than by calling the builder directly, so they also pin that the
// registration WIRES the builder up.

const dispatch: AgentDispatchContext = {
  baseBranch: 'main',
  workBranch: 'cat-factory/b1',
  multiRepo: false,
}

const context = (agentKind: string, over: Record<string, unknown> = {}): AgentRunContext =>
  ({
    agentKind,
    pipelineName: 'Ship',
    block: { id: 'b1', title: 'Add login', type: 'task' },
    decisions: [],
    priorOutputs: [],
    ...over,
  }) as unknown as AgentRunContext

const withPr = (number: number, branch: string) => ({
  block: { id: 'b1', title: 'T', type: 'task', pullRequest: { number, branch, url: 'u' } },
})

const registry = defaultAgentKindRegistry()
const prompt = (agentKind: string, over: Record<string, unknown> = {}, d = dispatch) =>
  userPromptFor(context(agentKind, over), registry, { materialized: true, dispatch: d })

describe('the merger prompt', () => {
  it('names the PR + branches so the agent diffs against the right base', () => {
    const p = prompt(MERGER_AGENT_KIND, withPr(42, 'feat/x'))
    expect(p).toContain('(PR #42)')
    expect(p).toContain('`feat/x`')
    expect(p).toContain('git diff origin/main...HEAD')
  })

  it('falls back to the base branch when there is no PR', () => {
    const p = prompt(MERGER_AGENT_KIND)
    expect(p).toContain('`main`')
    expect(p).not.toContain('(PR #')
  })

  it('scores the COMBINED change on a multi-repo dispatch', () => {
    const p = prompt(MERGER_AGENT_KIND, withPr(42, 'feat/x'), { ...dispatch, multiRepo: true })
    expect(p).toContain('spans MULTIPLE repositories')
    expect(p).toContain('SINGLE assessment')
    // The per-repo diff commands live in the system prompt's multi-repo section, so the task
    // prompt must NOT restate a single-repo diff command the agent would run against one of them.
    expect(p).not.toContain('git diff origin/main...HEAD')
  })

  it('names no branch when there is no checkout to name one from', () => {
    // An inline caller (a consensus panel) resolves no dispatch context. Inventing `main` there
    // would tell an agent with no filesystem to run git against a branch nobody checked out.
    const p = mergerUserPrompt(context(MERGER_AGENT_KIND, withPr(42, 'feat/x')))
    expect(p).toContain('(PR #42)')
    expect(p).not.toContain('git diff')
    expect(p).not.toContain('`main`')
  })
})

describe('the on-call prompt', () => {
  it('tells the agent how to locate the merged commit by PR number', () => {
    const p = prompt(ON_CALL_AGENT_KIND, withPr(7, 'feat/y'))
    expect(p).toContain('#7')
    expect(p).toContain('git log --oneline -n 50')
    expect(p).toContain('base branch `main`')
  })

  it('keeps the generic block context it reasons over', () => {
    // The regression evidence and the prior steps' output arrive through the GENERIC prompt; the
    // kind contributes only the closing instructions. A `userPrompt` that replaced the whole
    // prompt would leave the investigator with nothing to investigate.
    const p = prompt(ON_CALL_AGENT_KIND, withPr(7, 'feat/y'))
    expect(p).toContain('Block: T')
    expect(p).toContain('Pipeline: Ship')
  })

  it('closes on the reply-shape instruction even on a revision re-run', () => {
    // `userPromptSuffix` is the ADDITIVE form precisely so the kind's own closing instruction is
    // the last thing the agent reads. `withRevision` appends too, so a suffix folded into the
    // generic prompt body stopped being last the moment a human requested changes — leaving
    // "respond with ONLY a JSON object" buried above the reviewer's feedback, on the one pass
    // where the model has a competing instruction to follow.
    const p = prompt(ON_CALL_AGENT_KIND, {
      ...withPr(7, 'feat/y'),
      revision: { previousProposal: 'the last assessment', feedback: 'check the cache layer' },
    })
    expect(p).toContain('check the cache layer')
    expect(p.trimEnd().endsWith('"evidence":["…"]}.')).toBe(true)
  })

  it('closes on the reply-shape instruction after folded-in context files', () => {
    // The inline path (a consensus panel, the inline executor) folds the run's context-file bodies
    // in, which appends as well — and is the larger of the two appenders, so a suffix ahead of it
    // is the further from where the model looks for its instruction.
    const p = userPromptFor(
      context(ON_CALL_AGENT_KIND, {
        ...withPr(7, 'feat/y'),
        injectedContextFiles: [{ path: '.cat-context/incident.md', content: 'p99 doubled' }],
      }),
      registry,
      {},
    )
    expect(p).toContain('p99 doubled')
    expect(p.trimEnd().endsWith('"evidence":["…"]}.')).toBe(true)
  })
})

describe('the conflict-resolver prompt', () => {
  it('carries a COMPACT task reference, not the full run context', () => {
    // The generic prompt renders every prior agent's output, which buries the one-line "resolve a
    // conflict" role and drifts the model onto re-implementing the feature. The harness leads with
    // the actual conflict hunks, so intent is all the backend owes it.
    const p = prompt(CONFLICT_RESOLVER_AGENT_KIND, {
      block: { id: 'b1', title: 'T', type: 'task', description: 'why' },
      priorOutputs: [{ agentKind: 'coder', output: 'a very long implementation report' }],
    })
    expect(p).toBe('Task: T\n\nwhy')
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

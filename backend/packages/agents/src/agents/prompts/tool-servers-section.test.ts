import type { AgentRunContext, UnavailableToolServer } from '@cat-factory/kernel'
import { TOOL_SERVER_BUDGET } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { toolServersSection } from './capabilities.js'

// The tool-server section is the ONLY always-present channel telling an agent what extra tools it
// has and, just as importantly, which declared ones it does NOT. Both halves are contracts:
//
//   - an available server must reach the agent with its guidance and the CLI's real tool names, or
//     it is a tool the agent was handed and never uses;
//   - an unavailable one must be STATED, with wording that does not invite a retry, or the agent
//     plans around a tool that was never there and discovers the gap mid-run.
//
// The reason vocabulary is a closed union with an exhaustive `Record` behind it, so the coverage
// test below is what stops a new member rendering as a blank parenthetical.

function ctx(
  toolServers?: AgentRunContext['toolServers'],
  unavailableToolServers?: AgentRunContext['unavailableToolServers'],
): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Build',
    stepIndex: 1,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(toolServers ? { toolServers } : {}),
    ...(unavailableToolServers ? { unavailableToolServers } : {}),
  } as unknown as AgentRunContext
}

const ALL_REASONS: UnavailableToolServer['reason'][] = [
  'harness_unsupported',
  'transport_unsupported',
  'missing_secret',
  'reserved_secret',
  'over_budget',
]

describe('toolServersSection', () => {
  it('is empty for a kind with no tool servers, so every built-in prompt is byte-unchanged', () => {
    expect(toolServersSection(ctx())).toBe('')
    expect(toolServersSection(ctx([], []))).toBe('')
  })

  it('names each wired server with its guidance and the CLI’s own tool names', () => {
    const out = toolServersSection(
      ctx([
        {
          id: 'issues',
          label: 'Issue tracker',
          guidance: 'Look up an issue before guessing at its intent.',
          tools: ['search_issues', 'get_issue'],
          transport: 'stdio',
        },
      ]),
    )
    expect(out).toContain('**Issue tracker** (`issues`, runs in your sandbox)')
    expect(out).toContain('Look up an issue before guessing at its intent.')
    // The `mcp__<server>__<tool>` convention is what the agent sees in its own tool list, so the
    // prompt has to spell the names the same way or the agent cannot match one to the other.
    expect(out).toContain('`mcp__issues__search_issues`')
    expect(out).toContain('`mcp__issues__get_issue`')
  })

  it('distinguishes a sandbox-local server from a remote one', () => {
    const remote = toolServersSection(ctx([{ id: 'docs', label: 'Docs', transport: 'http' }]))
    expect(remote).toContain('remote service')
    expect(remote).not.toContain('runs in your sandbox')
  })

  it('lists no tool names for a server that restricted none', () => {
    // Absent `tools` means every tool the server exposes — enumerating nothing is right, and an
    // empty "Tools:" line would read as a server with no tools at all.
    const out = toolServersSection(ctx([{ id: 'docs', label: 'Docs', transport: 'stdio' }]))
    expect(out).not.toContain('Tools:')
  })

  it('states an unavailable server instead of omitting it', () => {
    const out = toolServersSection(
      ctx([], [{ id: 'docs', label: 'Docs', reason: 'missing_secret' }]),
    )
    expect(out).toContain('NOT available on this run')
    expect(out).toContain('Docs (its credential is not configured for this deployment)')
    // The agent is told to report the gap, because a run that verified less than it was asked to
    // must say so rather than reading as a clean pass.
    expect(out).toContain('say so in')
  })

  it('renders the unavailable half on its own, with no available servers at all', () => {
    // The commonest real shape: a Pi run, or a Codex run whose only server is http. The section
    // must still appear — this is precisely the case silence would hide.
    const out = toolServersSection(
      ctx(undefined, [{ id: 'docs', label: 'Docs', reason: 'transport_unsupported' }]),
    )
    expect(out).toContain('## Tool servers')
    expect(out).toContain('Docs (')
    expect(out).not.toContain('are connected for this run')
  })

  it('renders EVERY reason as real prose, so a new member cannot ship as a blank parenthetical', () => {
    for (const reason of ALL_REASONS) {
      const out = toolServersSection(ctx([], [{ id: 's', label: 'Server', reason }]))
      const rendered = /- Server \((.+)\)/.exec(out)?.[1]
      expect(rendered, `reason ${reason} renders nothing`).toBeTruthy()
      expect(rendered!.trim().length, `reason ${reason} renders empty`).toBeGreaterThan(10)
      // The phrasing is for the AGENT, not an operator: it must not name a deployment fault or
      // suggest the tool could be produced by trying harder.
      expect(rendered).not.toMatch(/misconfigur|retry|try again/i)
    }
  })

  it('tells the agent an over-budget drop is a cap rather than a fault', () => {
    const out = toolServersSection(ctx([], [{ id: 's', label: 'Server', reason: 'over_budget' }]))
    expect(out).toContain('too many tool servers were declared')
  })

  it('folds a runaway drop list into a stated count instead of one line per server', () => {
    // The wired list is capped per dispatch but the DROP list is not, so the runaway declaration the
    // cap exists for would otherwise arrive in the prompt anyway, one line each. Folded rather than
    // truncated: the agent still learns more was declared than it got.
    const dropped: UnavailableToolServer[] = Array.from(
      { length: TOOL_SERVER_BUDGET.maxStatedUnavailable + 5 },
      (_, i) => ({ id: `s${i}`, label: `S${i}`, reason: 'over_budget' }),
    )
    const out = toolServersSection(ctx([], dropped))
    expect(out).toContain('- S0 (')
    expect(out).toContain(`- S${TOOL_SERVER_BUDGET.maxStatedUnavailable - 1} (`)
    expect(out).not.toContain(`- S${TOOL_SERVER_BUDGET.maxStatedUnavailable} (`)
    expect(out).toContain('and 5 more declared tool servers, also not available on this run.')
  })

  it('states the fold in the singular when exactly one server was folded', () => {
    const dropped: UnavailableToolServer[] = Array.from(
      { length: TOOL_SERVER_BUDGET.maxStatedUnavailable + 1 },
      (_, i) => ({ id: `s${i}`, label: `S${i}`, reason: 'missing_secret' }),
    )
    expect(toolServersSection(ctx([], dropped))).toContain('and 1 more declared tool server,')
  })

  it('names every drop when the list fits, so the fold is invisible in the normal case', () => {
    const dropped: UnavailableToolServer[] = Array.from(
      { length: TOOL_SERVER_BUDGET.maxStatedUnavailable },
      (_, i) => ({ id: `s${i}`, label: `S${i}`, reason: 'harness_unsupported' }),
    )
    const out = toolServersSection(ctx([], dropped))
    expect(out).toContain(`- S${TOOL_SERVER_BUDGET.maxStatedUnavailable - 1} (`)
    expect(out).not.toContain('more declared tool')
  })
})

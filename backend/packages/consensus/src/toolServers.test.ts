import { describe, expect, it } from 'vitest'
import type { AgentRunContext, McpServerDefinition } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import { panelToolServerCeiling } from './toolServers.js'

// What a diverted step owes about the tool servers it will not get. The property under test is the
// one the whole slice exists for: a panel that withholds a declared server SAYS SO, in the prompt
// and on the record, rather than reading like a kind that declared none.

const ISSUES: McpServerDefinition = {
  id: 'issues',
  label: 'Issue tracker',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', 'issue-mcp'] },
}

function context(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'architect',
    pipelineName: 'pl',
    workspaceId: 'ws',
    executionId: 'ex',
    stepIndex: 1,
    isFinalStep: false,
    block: { id: 'blk', title: 'T', type: 'service', description: 'D' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as AgentRunContext
}

function registryWith(...servers: McpServerDefinition[]): AgentKindRegistry {
  const registry = new AgentKindRegistry()
  for (const server of servers) registry.registerToolServer(server)
  registry.assignToolServers(
    'architect',
    servers.map((server) => server.id),
  )
  return registry
}

describe('panelToolServerCeiling', () => {
  it('withholds every declared server under one reason, and states it in the prompt', () => {
    const ceiling = panelToolServerCeiling(context(), registryWith(ISSUES))
    expect(ceiling.record).toEqual({
      wired: [],
      unavailable: [{ id: 'issues', label: 'Issue tracker', reason: 'consensus_panel' }],
    })
    // The same section the container dispatch composes, so a panel names a withheld server in the
    // words a container run would.
    expect(ceiling.section).toContain('## Tool servers')
    expect(ceiling.section).toContain('Issue tracker')
    expect(ceiling.section).toContain('consensus panel')
    // Never the AVAILABLE half: a panel wires nothing, so advertising anything here would be the
    // exact "told about a tool it cannot call" failure the vocabulary exists to prevent.
    expect(ceiling.section).not.toContain('are connected for this run')
  })

  it('labels a server that declared no label with its id', () => {
    const ceiling = panelToolServerCeiling(context(), registryWith({ ...ISSUES, label: undefined }))
    expect(ceiling.record?.unavailable[0]?.label).toBe('issues')
  })

  it('records NOTHING and leaves the prompt unchanged when the kind declared no servers', () => {
    // An inline surface wires nothing by construction, so an all-empty record from one would claim
    // a resolution where no wiring was ever possible. Absent is the honest answer, and it is what
    // keeps a panel on an ordinary kind byte-for-byte as it was.
    const ceiling = panelToolServerCeiling(context(), new AgentKindRegistry())
    expect(ceiling.record).toBeUndefined()
    expect(ceiling.section).toBe('')
  })

  it('skips an id no registration matches rather than inventing a chip for it', () => {
    // Boot validation already reported the typo as an error, and there is no definition to name a
    // label from. Putting a registry fault in front of the agent as a missing capability would tell
    // it to plan around a tool that never existed anywhere.
    const registry = new AgentKindRegistry()
    registry.assignToolServers('architect', ['typo'])
    const ceiling = panelToolServerCeiling(context(), registry)
    expect(ceiling.record).toBeUndefined()
    expect(ceiling.section).toBe('')
  })
})

import type { AgentRunContext } from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { buildAgentContextRecord } from './agentContextRecord.js'

// The snapshot's tool-server entries are DEPRECATED (the step's `toolServers` is the authority)
// and served until the window in `backend/docs/public-api.md` closes. What these pin is the half
// that a removal-in-place would have broken: the shapes that shipped, and the fact that the
// snapshot is projected from the step's own record rather than recomputed, so the two cannot
// disagree while both are served.

const context = (): AgentRunContext =>
  ({
    agentKind: 'coder',
    pipelineName: 'Default',
    stepIndex: 2,
    block: { id: 'blk1', title: 'Task', description: '' },
  }) as unknown as AgentRunContext

const ids = { workspaceId: 'ws1', executionId: 'exec1' }

describe('buildAgentContextRecord tool-server extras (deprecated)', () => {
  it('projects the step record into the shapes that shipped', () => {
    const toolServers: DispatchToolServers = {
      wired: [
        { id: 'issues', label: 'Issue tracker', transport: 'stdio', tools: ['search_issues'] },
      ],
      unavailable: [{ id: 'docs', label: 'Docs', reason: 'missing_secret' }],
    }

    const record = buildAgentContextRecord(context(), {}, 'model-x', { ...ids, toolServers })

    // Ids only on the wired side, id-plus-reason on the other: the label and the narrowed tool
    // list are what the STEP added, and adding them here would be a second shape to keep.
    expect(record.extras?.toolServers).toEqual(['issues'])
    expect(record.extras?.unavailableToolServers).toEqual([
      { id: 'docs', reason: 'missing_secret' },
    ])
  })

  it('omits an empty list, exactly as before', () => {
    const record = buildAgentContextRecord(context(), {}, 'model-x', {
      ...ids,
      toolServers: { wired: [], unavailable: [] },
    })

    expect(record.extras).not.toHaveProperty('toolServers')
    expect(record.extras).not.toHaveProperty('unavailableToolServers')
  })

  it('omits both when the dispatch resolved no record at all', () => {
    const record = buildAgentContextRecord(context(), {}, 'model-x', ids)

    expect(record.extras).not.toHaveProperty('toolServers')
    expect(record.extras).not.toHaveProperty('unavailableToolServers')
  })
})

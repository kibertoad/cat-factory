import type {
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
  RecordAgentContextInput,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { AgentContextObservabilityService } from './AgentContextObservabilityService.js'

function fakeRepo() {
  const rows: AgentContextSnapshot[] = []
  const repo: AgentContextSnapshotRepository = {
    async record(s) {
      rows.push(s)
    },
    async listByExecution(_w, e) {
      return rows.filter((r) => r.executionId === e)
    },
    async deleteOlderThan() {
      return 0
    },
  }
  return { repo, rows }
}

function fakeSettings(storeAgentContext: boolean): WorkspaceSettingsRepository {
  const settings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS, storeAgentContext }
  return {
    async get() {
      return settings
    },
    async upsert() {},
  }
}

const input: RecordAgentContextInput = {
  workspaceId: 'ws',
  executionId: 'exec',
  agentKind: 'coder',
  stepIndex: 0,
  model: 'm',
  harness: 'pi',
  systemPrompt: 'sys',
  userPrompt: 'usr',
  fragments: [],
  contextFiles: [],
  extras: {},
}

const clock = { now: () => 123 }
const idGenerator = { next: (p: string) => `${p}_1` }

describe('AgentContextObservabilityService', () => {
  it('records a snapshot when both gates are open', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    await svc.record(input)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'ctx_1', createdAt: 123, workspaceId: 'ws' })
  })

  it('skips when the workspace disabled storeAgentContext', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(false),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    await svc.record(input)
    expect(rows).toHaveLength(0)
  })

  it('skips when prompt recording is disabled deployment-wide', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: false,
    })
    await svc.record(input)
    expect(rows).toHaveLength(0)
  })
})

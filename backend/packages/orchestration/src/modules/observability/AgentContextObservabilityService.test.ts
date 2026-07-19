import type {
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
  RecordAgentContextInput,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  AgentContextObservabilityService,
  MAX_AGENT_CONTEXT_CHARS,
  MAX_AGENT_CONTEXT_TOTAL_CHARS,
  SECRET_FILE_PLACEHOLDER,
} from './AgentContextObservabilityService.js'

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
    async listByWorkspaceIds() {
      return new Map()
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

  it('scrubs credentials from prompts, fragment bodies, and injected file content', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    await svc.record({
      ...input,
      systemPrompt: 'system prompt with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked',
      userPrompt: 'clone https://user:s3cr3ttoken0000@github.com/acme/repo.git',
      fragments: [{ id: 'frag1', body: 'x-api-key: super-secret-fragment-value' }],
      contextFiles: [
        {
          path: 'docs/notes.md',
          title: 'Notes',
          url: 'https://x/notes',
          content: 'here is a token: sk-ABCDEFGHIJKLMNOP1234567890',
        },
      ],
    })

    const stored = rows[0]!
    expect(stored.systemPrompt).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(stored.systemPrompt).toContain('[REDACTED]')
    expect(stored.userPrompt).not.toContain('s3cr3ttoken0000')
    // Non-secret context (the repo host, the prose) is preserved.
    expect(stored.userPrompt).toContain('github.com/acme/repo.git')
    expect(stored.fragments[0]!.body).not.toContain('super-secret-fragment-value')
    expect(stored.contextFiles[0]!.content).not.toContain('sk-ABCDEFGHIJKLMNOP1234567890')
    expect(stored.contextFiles[0]!.content).toContain('[REDACTED]')
  })

  it('drops the whole body of a secret-shaped context file', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    await svc.record({
      ...input,
      contextFiles: [
        {
          path: '.env.production',
          title: 'env',
          url: 'https://x/env',
          content: 'DATABASE_URL=postgres://u:p@h/db\nAPI_KEY=raw-value-no-scaffolding',
        },
        {
          path: 'guide.md',
          title: 'Guide',
          url: 'https://x/guide',
          content: 'ordinary documentation body',
        },
      ],
    })

    const stored = rows[0]!
    // The `.env` body is dropped wholesale — none of its raw content survives.
    expect(stored.contextFiles[0]!.content).toBe(SECRET_FILE_PLACEHOLDER)
    expect(stored.contextFiles[0]!.content).not.toContain('raw-value-no-scaffolding')
    expect(stored.contextFiles[0]!.content).not.toContain('postgres://')
    // A normal file alongside it is stored as usual.
    expect(stored.contextFiles[1]!.content).toBe('ordinary documentation body')
  })

  it('deep-scrubs credentials from free-text values in the extras bag', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    await svc.record({
      ...input,
      extras: {
        repo: { owner: 'acme', name: 'widgets' },
        webSearch: false,
        // Free-text, human-authored values that could embed a pasted token.
        decisions: 'approved; call it with x-api-key: super-secret-decision-value',
        revision: { feedback: 'clone https://user:s3cr3tfeedback000@github.com/acme/repo.git' },
      },
    })

    const stored = rows[0]!
    const extras = stored.extras as {
      repo: { owner: string; name: string }
      webSearch: boolean
      decisions: string
      revision: { feedback: string }
    }
    expect(extras.decisions).not.toContain('super-secret-decision-value')
    expect(extras.decisions).toContain('[REDACTED]')
    expect(extras.revision.feedback).not.toContain('s3cr3tfeedback000')
    // Structural, non-secret values are preserved for diagnostics.
    expect(extras.repo).toEqual({ owner: 'acme', name: 'widgets' })
    expect(extras.webSearch).toBe(false)
  })

  it('bounds the total snapshot size, preserving the prompts over trailing files', async () => {
    const { repo, rows } = fakeRepo()
    const svc = new AgentContextObservabilityService({
      agentContextSnapshotRepository: repo,
      workspaceSettingsRepository: fakeSettings(true),
      idGenerator,
      clock,
      recordPrompts: true,
    })
    // Each body sits at the per-body cap; enough files to overflow the aggregate budget
    // several times over (2 prompts + 10 files = ~12× the per-body cap).
    const body = MAX_AGENT_CONTEXT_CHARS
    await svc.record({
      ...input,
      systemPrompt: 'S'.repeat(body),
      userPrompt: 'U'.repeat(body),
      contextFiles: Array.from({ length: 10 }, (_, i) => ({
        path: `f${i}.md`,
        title: `F${i}`,
        url: `https://x/f${i}`,
        content: 'F'.repeat(body),
      })),
    })

    expect(rows).toHaveLength(1)
    const stored = rows[0]!
    // Prompts are filled first, so they survive intact; the trailing files are trimmed.
    expect(stored.systemPrompt).toBe('S'.repeat(body))
    expect(stored.userPrompt).toBe('U'.repeat(body))
    // The aggregate stays bounded (a small constant of trailing markers aside), so the
    // row can't balloon to several megabytes and get silently rejected by the store.
    const totalChars =
      stored.systemPrompt.length +
      stored.userPrompt.length +
      stored.contextFiles.reduce((n, f) => n + f.content.length, 0)
    expect(totalChars).toBeLessThan(MAX_AGENT_CONTEXT_TOTAL_CHARS + 1024)
  })
})

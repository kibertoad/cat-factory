import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_SETTINGS } from '../domain/catalog.js'
import type { WorkspaceSettings } from '../domain/types.js'
import type { GroupCacheHandle, WorkspaceSettingsCacheValue } from '../ports/caching.js'
import type { WorkspaceSettingsRepository } from '../ports/workspace-settings-repositories.js'
import { createStoreAgentContextGate } from './agent-context-gate.js'

// This gate is the per-workspace half of the double gate governing prompt/response BODY capture
// on EVERY path — persisted telemetry and the external trace fan-out alike. It is the one
// implementation of that rule precisely because there were once two, and the inline one honoured
// only the deployment switch, so an opted-out workspace still shipped its bodies to Langfuse/OTel
// (observability-logging-gaps.md, C2). Its answers are a privacy decision, so they are asserted
// here rather than left to the two consumers' tests.

function repositoryReturning(settings: WorkspaceSettings | null): WorkspaceSettingsRepository {
  return {
    get: vi.fn(async () => settings),
    listByWorkspaceIds: vi.fn(async () => new Map()),
    upsert: vi.fn(async () => {}),
  }
}

const withStoreAgentContext = (storeAgentContext: boolean): WorkspaceSettings => ({
  ...DEFAULT_WORKSPACE_SETTINGS,
  storeAgentContext,
})

describe('createStoreAgentContextGate', () => {
  it("honours a workspace's explicit opt-out", async () => {
    const gate = createStoreAgentContextGate({
      repository: repositoryReturning(withStoreAgentContext(false)),
    })
    expect(await gate('ws_1')).toBe(false)
  })

  it('allows capture for a workspace that has opted in', async () => {
    const gate = createStoreAgentContextGate({
      repository: repositoryReturning(withStoreAgentContext(true)),
    })
    expect(await gate('ws_1')).toBe(true)
  })

  it('falls back to the default settings for a workspace with no stored row', async () => {
    const gate = createStoreAgentContextGate({ repository: repositoryReturning(null) })
    expect(await gate('ws_1')).toBe(DEFAULT_WORKSPACE_SETTINGS.storeAgentContext)
  })

  // The two `true` answers below are deliberate fail-OPEN branches, not lenient defaults. They
  // are asserted so a future "tighten the gate" change has to state that it is changing a
  // documented decision rather than fixing an oversight.

  it('defers to the deployment switch when no settings source is wired', async () => {
    const gate = createStoreAgentContextGate({})
    expect(await gate('ws_1')).toBe(true)
  })

  it('defers to the deployment switch for an untagged call carrying no workspace', async () => {
    const repository = repositoryReturning(withStoreAgentContext(false))
    const gate = createStoreAgentContextGate({ repository })
    // Fail-open, AND without a read: there is no workspace whose opt-out could apply, so the
    // opted-out row above must not be consulted (nor any other).
    expect(await gate(null)).toBe(true)
    expect(repository.get).not.toHaveBeenCalled()
  })

  it('reads through the cache slice when the facade wired one', async () => {
    const repository = repositoryReturning(withStoreAgentContext(false))
    const cache = {
      get: vi.fn(async () => ({ settings: withStoreAgentContext(true) })),
    } as unknown as GroupCacheHandle<WorkspaceSettingsCacheValue>
    const gate = createStoreAgentContextGate({ repository, cache })
    // The cached value wins, and the repository is never touched — this read runs per recorded
    // call, so a cache miss per call would be a DB read per call.
    expect(await gate('ws_1')).toBe(true)
    expect(repository.get).not.toHaveBeenCalled()
  })

  it('propagates a settings read failure rather than answering it', async () => {
    const repository: WorkspaceSettingsRepository = {
      get: vi.fn(async () => {
        throw new Error('settings unreadable')
      }),
      listByWorkspaceIds: vi.fn(async () => new Map()),
      upsert: vi.fn(async () => {}),
    }
    // Deliberately NOT handled here: both callers fail CLOSED on a throw, because an unreadable
    // settings row is not consent. Swallowing it to `true` would be the C2 defect again.
    await expect(createStoreAgentContextGate({ repository })('ws_1')).rejects.toThrow(
      'settings unreadable',
    )
  })
})

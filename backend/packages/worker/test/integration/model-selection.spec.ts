import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/core'
import { MODEL_CATALOG, modelRefForId } from '@cat-factory/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

describe('per-block model selection', () => {
  describe('catalog', () => {
    it('resolves catalog ids to concrete workers-ai model refs', () => {
      const qwen = modelRefForId('qwen')
      expect(qwen).toEqual({ provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' })
      // The four advertised models are all present.
      expect(MODEL_CATALOG.map((m) => m.id)).toEqual([
        'cloudflare-llama',
        'qwen',
        'kimi',
        'deepseek',
      ])
      // Unknown / empty ids resolve to nothing so the caller falls back.
      expect(modelRefForId('does-not-exist')).toBeUndefined()
      expect(modelRefForId('')).toBeUndefined()
    })
  })

  describe('persistence', () => {
    let app: TestApp
    let wsId: string

    beforeEach(async () => {
      app = makeApp()
      const { workspace } = await app.createWorkspace()
      wsId = workspace.id
    })

    it('round-trips modelId through D1 and clears it on empty string', async () => {
      const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        modelId: 'kimi',
      })
      expect(patched.body.modelId).toBe('kimi')

      // Re-read from the snapshot to confirm it persisted, not just echoed.
      const snap = await app.call<{ blocks: Block[] }>('GET', `/workspaces/${wsId}`)
      const task = snap.body.blocks.find((b) => b.id === 'task_login')!
      expect(task.modelId).toBe('kimi')

      // An empty string resets back to the default routing (no selection).
      const cleared = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        modelId: '',
      })
      expect(cleared.body.modelId).toBeUndefined()
    })

    it('feeds the selected modelId into the agent run context', async () => {
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'deepseek' })

      const seen: AgentRunContext[] = []
      const capturing: AgentExecutor = {
        async run(context: AgentRunContext): Promise<AgentRunResult> {
          seen.push(context)
          return { output: 'ok', model: 'fake', confidence: 1 }
        },
      }
      const capturingApp = makeApp(capturing)

      await capturingApp.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: 'pl_quick',
      })
      await capturingApp.call('POST', `/workspaces/${wsId}/tick`, { ticks: 10 })

      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]!.block.modelId).toBe('deepseek')
    })
  })
})

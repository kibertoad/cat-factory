import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/kernel'
import { effectiveCatalog, MODEL_CATALOG, resolveModelRef } from '@cat-factory/kernel'
import type { ModelOption } from '@cat-factory/contracts'
import { modelCatalogSchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

// Direct-flavour key availability fakes for the resolver.
const noKeys = () => false
const allKeys = () => true

describe('per-block model selection', () => {
  describe('catalog resolution', () => {
    it('falls back to the Cloudflare flavour when no direct key is configured', () => {
      expect(resolveModelRef('cloudflare-llama', noKeys)).toEqual({
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
      })
      expect(resolveModelRef('qwen', noKeys)).toEqual({
        provider: 'workers-ai',
        model: '@cf/qwen/qwen3-30b-a3b-fp8',
      })
      expect(resolveModelRef('kimi', noKeys)).toEqual({
        provider: 'workers-ai',
        model: '@cf/moonshotai/kimi-k2.6',
      })
      expect(resolveModelRef('deepseek', noKeys)).toEqual({
        provider: 'workers-ai',
        model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      })
    })

    it('uses the direct flavour when the provider key is configured', () => {
      expect(resolveModelRef('qwen', allKeys)).toEqual({ provider: 'qwen', model: 'qwen3-max' })
      expect(resolveModelRef('kimi', allKeys)).toEqual({ provider: 'moonshot', model: 'kimi-k2.6' })
      expect(resolveModelRef('deepseek', allKeys)).toEqual({
        provider: 'deepseek',
        model: 'deepseek-chat',
      })
      // Llama has no direct variant, so it stays on Cloudflare even with keys.
      expect(resolveModelRef('cloudflare-llama', allKeys)).toEqual({
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
      })
    })

    it('honours each key independently', () => {
      const onlyDeepseek = (keyEnv: string) => keyEnv === 'DEEPSEEK_API_KEY'
      expect(resolveModelRef('deepseek', onlyDeepseek)).toEqual({
        provider: 'deepseek',
        model: 'deepseek-chat',
      })
      // Qwen's key is absent, so it stays on Cloudflare.
      expect(resolveModelRef('qwen', onlyDeepseek)?.provider).toBe('workers-ai')
    })

    it('reports the active flavour in the effective catalog', () => {
      const cloud = effectiveCatalog(noKeys)
      expect(cloud.map((m) => m.id)).toEqual(['cloudflare-llama', 'qwen', 'kimi', 'deepseek'])
      expect(cloud.every((m) => m.flavor === 'cloudflare')).toBe(true)
      expect(cloud.every((m) => m.providerLabel === 'Cloudflare')).toBe(true)

      const direct = effectiveCatalog(allKeys)
      expect(direct.find((m) => m.id === 'qwen')).toMatchObject({
        flavor: 'direct',
        providerLabel: 'DashScope',
        provider: 'qwen',
        model: 'qwen3-max',
      })
      // Llama has no direct variant, so it is always Cloudflare.
      expect(direct.find((m) => m.id === 'cloudflare-llama')?.flavor).toBe('cloudflare')
    })

    it('returns undefined for unknown/empty ids so the caller falls back', () => {
      expect(resolveModelRef('does-not-exist', allKeys)).toBeUndefined()
      expect(resolveModelRef('', allKeys)).toBeUndefined()
      expect(MODEL_CATALOG.map((m) => m.id)).toEqual([
        'cloudflare-llama',
        'qwen',
        'kimi',
        'deepseek',
      ])
    })
  })

  describe('catalog endpoint', () => {
    it('serves the effective catalog, validating against the contract', async () => {
      const app = makeApp()
      const res = await app.call<ModelOption[]>('GET', '/models')
      expect(res.status).toBe(200)
      expect(() => v.parse(modelCatalogSchema, res.body)).not.toThrow()
      // The test env configures no direct keys, so every model is Cloudflare.
      expect(res.body.map((m) => m.id)).toEqual(['cloudflare-llama', 'qwen', 'kimi', 'deepseek'])
      expect(res.body.every((m) => m.flavor === 'cloudflare')).toBe(true)
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
      await capturingApp.drive(wsId)

      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]!.block.modelId).toBe('deepseek')
    })
  })
})

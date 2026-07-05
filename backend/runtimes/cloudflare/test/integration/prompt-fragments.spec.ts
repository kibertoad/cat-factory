import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/kernel'
import { composeSystemPrompt, defaultAgentKindRegistry, systemPromptFor } from '@cat-factory/agents'
import { promptFragmentCatalogSchema, type PromptFragment } from '@cat-factory/contracts'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import * as v from 'valibot'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

describe('prompt fragments', () => {
  describe('catalog endpoint', () => {
    it('serves the build-static catalog, validating against the contract', async () => {
      const app = makeApp()
      const res = await app.call<PromptFragment[]>('GET', '/prompt-fragments')
      expect(res.status).toBe(200)
      // The wire payload must satisfy the shared contract schema.
      expect(() => v.parse(promptFragmentCatalogSchema, res.body)).not.toThrow()
      const ids = res.body.map((f) => f.id)
      expect(ids).toContain('node.performance')
      expect(ids).toContain('react.state-management')
    })
  })

  describe('per-block selection persistence', () => {
    let app: TestApp
    let wsId: string

    beforeEach(async () => {
      app = makeApp()
      const { workspace } = await app.createWorkspace()
      wsId = workspace.id
    })

    it('round-trips fragmentIds through D1', async () => {
      const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        fragmentIds: ['node.performance', 'node.best-practices'],
      })
      expect(patched.body.fragmentIds).toEqual(['node.performance', 'node.best-practices'])

      // Re-read from the snapshot to confirm it persisted, not just echoed.
      const snap = await app.call<{ blocks: Block[] }>('GET', `/workspaces/${wsId}`)
      const task = snap.body.blocks.find((b) => b.id === 'task_login')!
      expect(task.fragmentIds).toEqual(['node.performance', 'node.best-practices'])

      // Clearing the selection removes it.
      const cleared = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        fragmentIds: [],
      })
      expect(cleared.body.fragmentIds ?? []).toEqual([])
    })

    it('feeds the selected fragmentIds into the agent run context', async () => {
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        fragmentIds: ['node.performance'],
      })

      // A capturing executor records the context it is handed for each step.
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
      expect(seen[0]!.block.fragmentIds).toEqual(['node.performance'])
    })
  })

  describe('composeSystemPrompt', () => {
    const base = systemPromptFor('coder', defaultAgentKindRegistry())

    it('appends the bodies of known fragments under a standards header', () => {
      const node = FRAGMENTS.find((f) => f.id === 'node.performance')!
      const composed = composeSystemPrompt(base, ['node.performance'])
      expect(composed).toContain(base)
      expect(composed).toContain('Follow these standards')
      expect(composed).toContain(node.body)
    })

    it('skips unknown ids and no-ops on an empty selection', () => {
      expect(composeSystemPrompt(base, [])).toBe(base)
      expect(composeSystemPrompt(base, ['does.not.exist'])).toBe(base)
    })
  })
})

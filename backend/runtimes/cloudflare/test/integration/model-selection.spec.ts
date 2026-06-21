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

// Derive expectations from the catalog itself rather than hardcoding its members, so
// these stay green as models are added/removed/renamed — they assert the resolution
// *behaviour*, not a snapshot of the model list.
const directModels = MODEL_CATALOG.filter((m) => m.direct)
const cloudflareOnlyModels = MODEL_CATALOG.filter((m) => !m.direct)

describe('per-block model selection', () => {
  describe('catalog resolution', () => {
    it('falls back to the Cloudflare flavour when no direct key is configured', () => {
      // Every model resolves to its always-available Cloudflare variant.
      for (const model of MODEL_CATALOG) {
        expect(resolveModelRef(model.id, noKeys)).toEqual(model.cloudflare)
      }
    })

    it('uses the direct flavour when the provider key is configured', () => {
      // A model with a direct variant switches to it; one without stays on Cloudflare.
      expect(directModels.length).toBeGreaterThan(0)
      for (const model of MODEL_CATALOG) {
        expect(resolveModelRef(model.id, allKeys)).toEqual(model.direct?.ref ?? model.cloudflare)
      }
    })

    it('honours each key independently', () => {
      // With only one provider's key present, only that model goes direct; every other
      // model — including other direct-capable ones — stays on Cloudflare.
      const target = directModels[0]
      expect(target).toBeDefined()
      const onlyTarget = (keyEnv: string) => keyEnv === target!.direct!.keyEnv

      expect(resolveModelRef(target!.id, onlyTarget)).toEqual(target!.direct!.ref)

      const otherDirect = directModels.find((m) => m.direct!.keyEnv !== target!.direct!.keyEnv)
      if (otherDirect) {
        expect(resolveModelRef(otherDirect.id, onlyTarget)?.provider).toBe('workers-ai')
      }
    })

    it('reports the active flavour in the effective catalog', () => {
      // The effective catalog is the catalog projected onto its in-use flavours: one
      // option per model, same ids, same order.
      const cloud = effectiveCatalog(noKeys)
      expect(cloud.map((m) => m.id)).toEqual(MODEL_CATALOG.map((m) => m.id))
      expect(cloud.every((m) => m.flavor === 'cloudflare')).toBe(true)
      expect(cloud.every((m) => m.providerLabel === 'Cloudflare')).toBe(true)

      const direct = effectiveCatalog(allKeys)
      for (const model of MODEL_CATALOG) {
        const option = direct.find((o) => o.id === model.id)!
        if (model.direct) {
          expect(option).toMatchObject({
            flavor: 'direct',
            providerLabel: model.direct.providerLabel,
            provider: model.direct.ref.provider,
            model: model.direct.ref.model,
          })
        } else {
          // No direct variant → always Cloudflare, even with every key configured.
          expect(option.flavor).toBe('cloudflare')
        }
      }
      // The two flavour branches above are only meaningful if the catalog exercises both.
      expect(directModels.length).toBeGreaterThan(0)
      expect(cloudflareOnlyModels.length).toBeGreaterThan(0)
    })

    it('returns undefined for unknown/empty ids so the caller falls back', () => {
      expect(resolveModelRef('does-not-exist', allKeys)).toBeUndefined()
      expect(resolveModelRef('', allKeys)).toBeUndefined()
      // The inverse holds: every real catalog id resolves, and ids are unique.
      const ids = MODEL_CATALOG.map((m) => m.id)
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(resolveModelRef(id, noKeys)).toBeDefined()
    })
  })

  describe('catalog endpoint', () => {
    it('serves the effective catalog, validating against the contract', async () => {
      const app = makeApp()
      const res = await app.call<ModelOption[]>('GET', '/models')
      expect(res.status).toBe(200)
      expect(() => v.parse(modelCatalogSchema, res.body)).not.toThrow()
      // The endpoint serves the effective catalog; the test env configures no direct
      // keys, so it matches the keyless projection and every model is Cloudflare.
      expect(res.body.map((m) => m.id)).toEqual(effectiveCatalog(noKeys).map((m) => m.id))
      expect(res.body.length).toBeGreaterThan(0)
      expect(res.body.every((m) => m.flavor === 'cloudflare')).toBe(true)
    })
  })

  describe('persistence', () => {
    // Pick concrete selectable ids from the catalog rather than naming specific models.
    const SELECTED_MODEL_ID = MODEL_CATALOG[0]!.id
    const OTHER_MODEL_ID = MODEL_CATALOG[1]?.id ?? MODEL_CATALOG[0]!.id

    let app: TestApp
    let wsId: string

    beforeEach(async () => {
      app = makeApp()
      const { workspace } = await app.createWorkspace()
      wsId = workspace.id
    })

    it('round-trips modelId through D1 and clears it on empty string', async () => {
      const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        modelId: SELECTED_MODEL_ID,
      })
      expect(patched.body.modelId).toBe(SELECTED_MODEL_ID)

      // Re-read from the snapshot to confirm it persisted, not just echoed.
      const snap = await app.call<{ blocks: Block[] }>('GET', `/workspaces/${wsId}`)
      const task = snap.body.blocks.find((b) => b.id === 'task_login')!
      expect(task.modelId).toBe(SELECTED_MODEL_ID)

      // An empty string resets back to the default routing (no selection).
      const cleared = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        modelId: '',
      })
      expect(cleared.body.modelId).toBeUndefined()
    })

    it('feeds the selected modelId into the agent run context', async () => {
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: OTHER_MODEL_ID })

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
      expect(seen[0]!.block.modelId).toBe(OTHER_MODEL_ID)
    })
  })
})

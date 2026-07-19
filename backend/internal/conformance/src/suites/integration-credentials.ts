import type { ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

export function defineCredentialsConformance(harness: ConformanceHarness): void {
  describe('vendor credentials (subscription token pool)', () => {
    it('adds, lists (secret-free), and removes pooled subscription tokens', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/vendor-credentials`

      // A fresh workspace has an empty pool.
      const initial = await call<{ credentials: unknown[] }>('GET', base)
      expect(initial.status).toBe(200)
      expect(initial.body.credentials).toEqual([])

      // Add two tokens (a pool) for the poolable, organization-permitted coding-plan
      // vendors — the raw token is write-only. (Claude/GLM/ChatGPT-Codex are individual-
      // usage only and are NOT poolable; that is asserted separately below.)
      const first = await call<{ id: string; vendor: string; label: string }>('POST', base, {
        vendor: 'kimi',
        label: 'moonshot',
        token: 'kimi-coding-plan-secret-one',
      })
      expect(first.status).toBe(201)
      expect(first.body.vendor).toBe('kimi')
      // The secret is never echoed back.
      expect(JSON.stringify(first.body)).not.toContain('secret-one')
      const second = await call<{ id: string; vendor: string }>('POST', base, {
        vendor: 'deepseek',
        label: 'deepseek',
        token: 'deepseek-coding-plan-secret-two',
      })
      expect(second.status).toBe(201)
      expect(second.body.vendor).toBe('deepseek')

      // Both list back as metadata only (the unfiltered GET covers every poolable vendor).
      const listed = await call<{ credentials: { id: string; vendor: string }[] }>('GET', base)
      expect(listed.body.credentials).toHaveLength(2)
      expect(listed.body.credentials.map((c) => c.vendor).sort()).toEqual(['deepseek', 'kimi'])
      expect(JSON.stringify(listed.body)).not.toContain('secret-')

      // Remove one; the other survives.
      const del = await call('DELETE', `${base}/${first.body.id}`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ credentials: { id: string }[] }>('GET', base)
      expect(afterDelete.body.credentials.map((c) => c.id).sort()).toEqual([second.body.id])
    })

    it('refuses to pool any individual-usage subscription (Claude / GLM / Codex)', async () => {
      const { call, createOrgWorkspace } = harness.makeApp()
      // An organization-owned workspace is the case the rule most matters for (pooling an
      // individual-use credential across an org breaches the vendor's terms), but the rule
      // is account-agnostic — these vendors are never poolable on ANY workspace.
      const { workspace } = await createOrgWorkspace()
      const base = `/workspaces/${workspace.id}/vendor-credentials`

      // Every vendor whose own terms license it for individual use only is never poolable
      // on a workspace (409 ConflictError) — they are stored per-user via the
      // personal-subscription endpoints instead.
      for (const [vendor, token] of [
        ['claude', 'sk-ant-oat01-secret'],
        ['glm', 'glm-coding-plan-individual-secret'],
        ['codex', '{"auth_mode":"chatgpt","tokens":{"access_token":"secret"}}'],
      ] as const) {
        const res = await call('POST', base, { vendor, label: 'shared', token })
        expect(res.status).toBe(409)
      }

      // An organization-permitted coding-plan vendor (DeepSeek) carries no restriction.
      const deepseek = await call<{ vendor: string }>('POST', base, {
        vendor: 'deepseek',
        label: 'deepseek',
        token: 'deepseek-coding-plan-secret',
      })
      expect(deepseek.status).toBe(201)
      expect(deepseek.body.vendor).toBe('deepseek')
    })
  })

  describe('provider API keys (DB-backed pool) + provider-gated pipelines', () => {
    // These run with the Cloudflare-AI opt-in forced OFF on every runtime (the Worker
    // binds `AI` in tests, Node never does), so selectability + the start guard depend
    // purely on the DB-backed key pool — and assert identically across runtimes.
    type Opt = {
      id: string
      flavor: string
      available?: boolean
      provider?: string
      model?: string
      contextTokens?: number
      cost?: { inputPerMillion: number; outputPerMillion: number; currency: string }
    }
    const KEY = { provider: 'qwen', label: 'team', key: 'qwen-api-key-secret' }

    it('adds, lists (secret-free), and removes workspace-scoped API keys', async () => {
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: false,
      })
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/api-keys`

      const initial = await call<{ keys: unknown[] }>('GET', base)
      expect(initial.status).toBe(200)
      expect(initial.body.keys).toEqual([])

      const created = await call<{ id: string; provider: string; scope: string }>('POST', base, KEY)
      expect(created.status).toBe(201)
      expect(created.body.provider).toBe('qwen')
      expect(created.body.scope).toBe('workspace')
      // The raw key is write-only — never echoed back.
      expect(JSON.stringify(created.body)).not.toContain('secret')

      const listed = await call<{ keys: { id: string; provider: string }[] }>('GET', base)
      expect(listed.body.keys).toHaveLength(1)
      expect(JSON.stringify(listed.body)).not.toContain('secret')

      const del = await call('DELETE', `${base}/${created.body.id}`)
      expect(del.status).toBe(204)
      const after = await call<{ keys: unknown[] }>('GET', base)
      expect(after.body.keys).toEqual([])
    })

    it('makes a direct model selectable once its provider key is configured', async () => {
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: false,
      })
      const { workspace } = await createWorkspace()
      const models = `/workspaces/${workspace.id}/models`

      // Cloudflare AI off + no key ⇒ the dual-mode `qwen` model is unselectable.
      const before = await call<Opt[]>('GET', models)
      expect(before.body.find((m) => m.id === 'qwen')?.available).toBe(false)

      await call('POST', `/workspaces/${workspace.id}/api-keys`, KEY)

      // The per-workspace catalog now resolves qwen to its DIRECT flavour, selectable.
      const after = await call<Opt[]>('GET', models)
      const qwen = after.body.find((m) => m.id === 'qwen')!
      expect(qwen.available).toBe(true)
      expect(qwen.flavor).toBe('direct')
    })

    it('makes an OpenRouter (OpenAI-compatible) model selectable once its key is configured', async () => {
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: false,
      })
      const { workspace } = await createWorkspace()
      const models = `/workspaces/${workspace.id}/models`

      // `gemini` is reachable only through the OpenRouter gateway (no Cloudflare/native
      // direct flavour): with no key it is unselectable on both runtimes.
      const before = await call<Opt[]>('GET', models)
      expect(before.body.find((m) => m.id === 'gemini')?.available).toBe(false)

      // Connect an OpenRouter key (exercises the widened apiKeyProviderSchema end to end).
      const created = await call('POST', `/workspaces/${workspace.id}/api-keys`, {
        provider: 'openrouter',
        label: 'team',
        key: 'sk-or-secret',
      })
      expect(created.status).toBe(201)

      // The curated entry now resolves to its OpenRouter gateway flavour, selectable.
      const after = await call<Opt[]>('GET', models)
      const or = after.body.find((m) => m.id === 'gemini')!
      expect(or.available).toBe(true)
      expect(or.flavor).toBe('openrouter')
    })

    it('surfaces an enabled OpenRouter dynamic-catalog model in the per-workspace catalog — identically per store', async () => {
      const app = harness.makeApp(undefined, { cloudflareModelsEnabled: false })
      const probe = app.openRouterCatalog?.()
      // Facades without the API-key pool (no ENCRYPTION_KEY) don't wire the store.
      if (!probe) return
      const { workspace } = await app.createWorkspace()
      const models = `/workspaces/${workspace.id}/models`

      // Connect an OpenRouter key so the gateway is in `directProviders`.
      await app.call('POST', `/workspaces/${workspace.id}/api-keys`, {
        provider: 'openrouter',
        label: 'team',
        key: 'sk-or-secret',
      })

      // Enable one dynamic OpenRouter model with cached context + price.
      const saved = await probe.upsert(workspace.id, {
        models: [
          {
            id: 'x-ai/grok-4',
            name: 'Grok 4',
            contextLength: 256_000,
            inputPerMillion: 3,
            outputPerMillion: 15,
          },
        ],
      })
      expect(saved.models).toHaveLength(1)
      // The enabled subset round-trips through the store (parity across D1 + Postgres).
      expect((await probe.get(workspace.id)).models[0]!.id).toBe('x-ai/grok-4')

      // It now appears in the per-workspace catalog as a selectable openrouter-flavour
      // model, carrying the cached context + the price overlaid onto the spend table.
      const after = await app.call<Opt[]>('GET', models)
      const dyn = after.body.find((m) => m.id === 'openrouter:x-ai/grok-4')!
      expect(dyn.available).toBe(true)
      expect(dyn.flavor).toBe('openrouter')
      expect(dyn.provider).toBe('openrouter')
      expect(dyn.model).toBe('x-ai/grok-4')
      expect(dyn.contextTokens).toBe(256_000)
      expect(dyn.cost?.inputPerMillion).toBe(3)
      expect(dyn.cost?.outputPerMillion).toBe(15)
    })

    it('keeps a base-URL-required provider (LiteLLM) unselectable with a key but no base URL', async () => {
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: false,
      })
      const { workspace } = await createWorkspace()
      const models = `/workspaces/${workspace.id}/models`

      // LiteLLM is operator-hosted: it has NO built-in base URL, and the test env sets
      // no LITELLM_BASE_URL. Connecting a key alone must NOT make it selectable — the
      // run would otherwise pass the start guard and then throw "No base URL configured"
      // at dispatch. (OpenRouter, with a public default, IS selectable on a key — above.)
      const created = await call('POST', `/workspaces/${workspace.id}/api-keys`, {
        provider: 'litellm',
        label: 'team',
        key: 'sk-litellm-secret',
      })
      expect(created.status).toBe(201)

      const after = await call<Opt[]>('GET', models)
      expect(after.body.find((m) => m.id === 'litellm-default')?.available).toBe(false)
    })

    it('blocks starting a pipeline with an unconfigured model, then allows it after a key is added', async () => {
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: false,
      })
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // Pin the seeded task to qwen; with Cloudflare off and no key it has no provider.
      await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
      const blocked = await call<{
        error: { code: string; details?: { reason?: string; models?: string[] } }
      }>('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: 'pl_quick',
      })
      expect(blocked.status).toBe(409)
      // The conflict carries a distinct machine-readable reason (+ the offending model
      // ids) so the SPA can react precisely (open AI setup) instead of string-matching.
      expect(blocked.body.error.code).toBe('conflict')
      expect(blocked.body.error.details?.reason).toBe('providers_unconfigured')
      expect(blocked.body.error.details?.models).toContain('qwen')

      // Configure a qwen key → the guard passes and the run starts.
      await call('POST', `/workspaces/${wsId}/api-keys`, KEY)
      const ok = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: 'pl_quick',
      })
      expect(ok.status).toBe(201)
    })

    it('runs the SAME provider guard on RETRY as on start (refuses a retry gone unsatisfiable)', async () => {
      // A retry re-drives the failed run through the same steps, so it must be gated exactly
      // like a start — otherwise a run that failed under a now-unconfigured model silently
      // re-dispatches and fails again mid-run (the drift that let a subscription-only preset
      // slip past retry). Start under a configured model, fail it, remove the provider, retry →
      // refused up front with the same conflict a fresh start gives.
      const { call, createWorkspace, drive } = harness.makeApp(
        { asyncKinds: ['coder'], dispatchThrowKinds: ['coder'] },
        { cloudflareModelsEnabled: false },
      )
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // Configure a qwen key + pin qwen so the start guard passes, then fail the run.
      const key = await call<{ id: string }>('POST', `/workspaces/${wsId}/api-keys`, KEY)
      await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
      const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build only',
        agentKinds: ['coder'],
      })
      const start = await call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')

      // Remove the provider key → the pinned model is no longer usable for THIS workspace.
      const removed = await call('DELETE', `/workspaces/${wsId}/api-keys/${key.body.id}`)
      expect(removed.status).toBe(204)

      // Retry the failed run → refused with the same providers_unconfigured conflict as a start,
      // because retry now shares start's `assertRunnable` gate.
      const retried = await call<{ error: { details?: { reason?: string } } }>(
        'POST',
        `/workspaces/${wsId}/agent-runs/${exec.id}/retry`,
      )
      expect(retried.status).toBe(409)
      expect(retried.body.error.details?.reason).toBe('providers_unconfigured')
    })

    it('runs the SAME provider guard on RESTART-from-step as on start', async () => {
      // A restart re-dispatches the stored steps just like a retry (from an arbitrary step),
      // so it must be gated identically — otherwise a run whose model went unconfigured slips
      // past restart and strands mid-run. Start under a configured model, fail it, remove the
      // provider, restart from step 0 → refused up front with the same conflict a start gives.
      const { call, createWorkspace, drive } = harness.makeApp(
        { asyncKinds: ['coder'], dispatchThrowKinds: ['coder'] },
        { cloudflareModelsEnabled: false },
      )
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const key = await call<{ id: string }>('POST', `/workspaces/${wsId}/api-keys`, KEY)
      await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
      const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build only',
        agentKinds: ['coder'],
      })
      const start = await call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')

      const removed = await call('DELETE', `/workspaces/${wsId}/api-keys/${key.body.id}`)
      expect(removed.status).toBe(204)

      // Restart from the first step → refused with providers_unconfigured, because restart now
      // shares start's `assertRunnable` gate over the stored steps it re-drives.
      const restarted = await call<{ error: { details?: { reason?: string } } }>(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/restart`,
        { fromStepIndex: 0 },
      )
      expect(restarted.status).toBe(409)
      expect(restarted.body.error.details?.reason).toBe('providers_unconfigured')
    })
  })
}

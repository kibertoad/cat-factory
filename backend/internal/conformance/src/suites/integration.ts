import { resolveDocTemplate } from '@cat-factory/agents'
import {
  type ComposeRuntime,
  type EnvironmentBackendProvider,
  type RunnerBackendProvider,
  composeEnvironmentBackend,
  createBackendRegistries,
} from '@cat-factory/integrations'
import type {
  Block,
  DeployCloneTarget,
  DocumentRecord,
  EnvironmentProvider,
  ExecutionInstance,
  Pipeline,
  RepoValidationResult,
  RiskPolicy,
  RunRepoContext,
  RunnerJobRef,
  RunnerJobView,
  SourceTask,
  TaskRecord,
  TaskSourceDiagnostic,
  TaskSourceState,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

export function defineIntegrationConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
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

        const created = await call<{ id: string; provider: string; scope: string }>(
          'POST',
          base,
          KEY,
        )
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

    describe('merge presets', () => {
      it('seeds the built-in catalog, enforces the single-default invariant, and guards the default', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/risk-policies`

        // First list lazily seeds the whole built-in catalog: Balanced (default, auto-merge on)
        // and "Manual review only" (non-default, auto-merge OFF).
        const initial = await call<RiskPolicy[]>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body).toHaveLength(2)
        const balanced = initial.body.find((p) => p.id === 'mp_balanced')!
        const manual = initial.body.find((p) => p.id === 'mp_manual_review')!
        expect(balanced.isDefault).toBe(true)
        expect(balanced.autoMergeEnabled).toBe(true)
        expect(balanced.version).toBe(3)
        // The QC-companion budget round-trips with its default through both stores.
        expect(balanced.maxTesterQualityIterations).toBe(3)
        // "Manual review only" fully prevents auto-merge: every PR is routed to human review.
        expect(manual.isDefault).toBe(false)
        expect(manual.autoMergeEnabled).toBe(false)
        // The post-release-health knobs round-trip with their defaults through both stores.
        expect(balanced.releaseWatchWindowMinutes).toBe(30)
        expect(balanced.releaseMaxAttempts).toBe(1)
        const seededDefaultId = balanced.id

        // Add a non-default preset; the seeded default stays the default.
        const lenient = await call<RiskPolicy>('POST', base, {
          name: 'Lenient',
          maxComplexity: 0.9,
          maxRisk: 0.8,
          maxImpact: 0.7,
          ciMaxAttempts: 5,
          maxRequirementIterations: 5,
          maxRequirementConcernAllowed: 'medium',
          maxTesterQualityIterations: 4,
          releaseWatchWindowMinutes: 45,
          releaseMaxAttempts: 2,
        })
        expect(lenient.status).toBe(201)
        expect(lenient.body.isDefault).toBe(false)
        // The requirements-loop + QC + release-health fields round-trip through the store on both runtimes.
        expect(lenient.body.maxRequirementIterations).toBe(5)
        expect(lenient.body.maxRequirementConcernAllowed).toBe('medium')
        expect(lenient.body.maxTesterQualityIterations).toBe(4)
        expect(lenient.body.releaseWatchWindowMinutes).toBe(45)
        expect(lenient.body.releaseMaxAttempts).toBe(2)

        // Promote a brand-new preset to default; the previous default is demoted
        // (single-default invariant enforced by the repository).
        const strict = await call<RiskPolicy>('POST', base, {
          name: 'Strict',
          maxComplexity: 0.3,
          maxRisk: 0.2,
          maxImpact: 0.2,
          ciMaxAttempts: 10,
          maxRequirementIterations: 2,
          maxRequirementConcernAllowed: 'none',
          isDefault: true,
        })
        expect(strict.status).toBe(201)
        expect(strict.body.isDefault).toBe(true)

        const afterPromote = await call<RiskPolicy[]>('GET', base)
        // Two seeded built-ins + Lenient + Strict.
        expect(afterPromote.body).toHaveLength(4)
        const defaults = afterPromote.body.filter((p) => p.isDefault)
        expect(defaults.map((p) => p.id)).toEqual([strict.body.id])
        expect(afterPromote.body.find((p) => p.id === seededDefaultId)!.isDefault).toBe(false)

        // The default cannot be unset via PATCH, nor removed via DELETE.
        const unset = await call('PATCH', `${base}/${strict.body.id}`, { isDefault: false })
        expect(unset.status).toBe(409)
        const delDefault = await call('DELETE', `${base}/${strict.body.id}`)
        expect(delDefault.status).toBe(409)

        // A non-default preset can be patched and removed.
        const renamed = await call<RiskPolicy>('PATCH', `${base}/${lenient.body.id}`, {
          name: 'Lenient v2',
        })
        expect(renamed.status).toBe(200)
        expect(renamed.body.name).toBe('Lenient v2')
        const del = await call('DELETE', `${base}/${lenient.body.id}`)
        expect(del.status).toBe(204)
        const final = await call<RiskPolicy[]>('GET', base)
        expect(final.body.map((p) => p.id).sort()).toEqual(
          [seededDefaultId, 'mp_manual_review', strict.body.id].sort(),
        )
      })

      it('ships catalog versions on the snapshot and reseeds a built-in (drift repair + new appeared)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const base = `/workspaces/${wsId}/risk-policies`

        // The snapshot ships the built-in catalog versions so the SPA can offer a reseed.
        const snap = await call<{ riskPolicyCatalogVersions?: Record<string, number> }>(
          'GET',
          `/workspaces/${wsId}`,
        )
        expect(snap.body.riskPolicyCatalogVersions).toMatchObject({
          mp_balanced: 3,
          mp_manual_review: 3,
        })

        // Seed, then drift a built-in (turn its auto-merge OFF + rename). Reseed must restore the
        // canonical definition + version while preserving the user's default + ordering.
        await call('GET', base)
        await call('PATCH', `${base}/mp_balanced`, {
          name: 'Tampered',
          autoMergeEnabled: false,
        })
        const reseeded = await call<RiskPolicy>('POST', `${base}/mp_balanced/reseed`)
        expect(reseeded.status).toBe(200)
        expect(reseeded.body.name).toBe('Balanced')
        expect(reseeded.body.autoMergeEnabled).toBe(true)
        expect(reseeded.body.version).toBe(3)
        // The default is preserved across a reseed.
        expect(reseeded.body.isDefault).toBe(true)

        // Reseeding a NEW built-in the workspace doesn't have yet materialises it (the
        // "appeared upstream" case): delete the manual preset, then reseed it back.
        await call('DELETE', `${base}/mp_manual_review`)
        const afterDelete = await call<RiskPolicy[]>('GET', base)
        expect(afterDelete.body.some((p) => p.id === 'mp_manual_review')).toBe(false)
        const readded = await call<RiskPolicy>('POST', `${base}/mp_manual_review/reseed`)
        expect(readded.status).toBe(200)
        expect(readded.body.autoMergeEnabled).toBe(false)

        // Re-materialising a default-flagged built-in must NOT steal the default: promote a
        // custom preset to default, delete the (now non-default) mp_balanced, then reseed it.
        // mp_balanced's seed is default-flagged, but the workspace already has a default, so the
        // reseed re-creates it as NON-default and the user's choice survives.
        const custom = await call<RiskPolicy>('POST', base, {
          name: 'My default',
          maxComplexity: 0.5,
          maxRisk: 0.5,
          maxImpact: 0.5,
          ciMaxAttempts: 5,
          maxRequirementIterations: 5,
          maxRequirementConcernAllowed: 'none',
          isDefault: true,
        })
        expect(custom.body.isDefault).toBe(true)
        await call('DELETE', `${base}/mp_balanced`)
        const rebalanced = await call<RiskPolicy>('POST', `${base}/mp_balanced/reseed`)
        expect(rebalanced.status).toBe(200)
        expect(rebalanced.body.isDefault).toBe(false)
        const afterReseed = await call<RiskPolicy[]>('GET', base)
        expect(afterReseed.body.filter((p) => p.isDefault).map((p) => p.id)).toEqual([
          custom.body.id,
        ])

        // A non-catalog id cannot be reseeded (it would be a custom preset — delete instead).
        const bad = await call('POST', `${base}/mp_not_a_builtin/reseed`)
        expect(bad.status).toBe(422)
      })
    })

    describe('runner backend connection (discriminated kind)', () => {
      type RunnerConnection = {
        kind: string
        secretKeys: string[]
        config?: { kind: string; kubernetes?: { namespace?: string; image?: string } }
      }

      it('round-trips the discriminated backend kind + config through the store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/runner-pool/connection`

        // Register a native Kubernetes backend (no real cluster needed — register only
        // validates + persists). The `kind` column + the discriminated `config` blob must
        // round-trip identically through the D1 and Drizzle repos.
        const registered = await call<RunnerConnection>('POST', base, {
          config: {
            kind: 'kubernetes',
            kubernetes: {
              label: 'Prod',
              apiServerUrl: 'https://k8s.example:6443',
              namespace: 'cat-factory',
              image: 'ghcr.io/acme/executor:1',
            },
          },
          secrets: { apiToken: 'sa-token' },
        })
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe('kubernetes')
        expect(registered.body.secretKeys).toContain('apiToken')

        const got = await call<{ connection: RunnerConnection | null }>('GET', base)
        expect(got.status).toBe(200)
        expect(got.body.connection?.kind).toBe('kubernetes')
        // The non-secret config is exposed (sans token) so the connect form can prefill.
        expect(got.body.connection?.config?.kind).toBe('kubernetes')
        expect(got.body.connection?.config?.kubernetes?.namespace).toBe('cat-factory')
        expect(got.body.connection?.secretKeys).toContain('apiToken')

        // Re-registering a manifest backend replaces it; the discriminator flips back.
        const manifest = await call<RunnerConnection>('POST', base, {
          config: {
            kind: 'manifest',
            manifest: {
              providerId: 'acme-pool',
              label: 'Acme',
              baseUrl: 'https://pool.test/api',
              auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
              dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
              poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
              response: { statusPath: 'state' },
            },
          },
          secrets: { API_TOKEN: 'tok' },
        })
        expect(manifest.status).toBe(201)
        expect(manifest.body.kind).toBe('manifest')
        const afterManifest = await call<{ connection: RunnerConnection | null }>('GET', base)
        expect(afterManifest.body.connection?.kind).toBe('manifest')
        expect(afterManifest.body.connection?.config?.kind).toBe('manifest')
      })
    })

    describe('custom backend kinds (programmatic registration)', () => {
      // A single-tenant / self-hosted deployment registers a bespoke environment or runner
      // backend programmatically (an import side effect) — the public extension seam that
      // replaced the removed deployment-wide provider injection. A custom kind rides the
      // contract's generic manifest member (NO new config variant), so it must: pass connect
      // validation, round-trip its kind+config through the store, be describable BEFORE the
      // first connect, and be advertised in the snapshot — identically on every runtime. A
      // facade that didn't open its repos/validation to a custom kind fails here.
      //
      // Registered BY REFERENCE into an app-owned registry the harness injects through
      // `makeApp({ backendRegistries })` — exactly how a real deployment registers a custom
      // backend (no module-global side effect, so module identity is irrelevant).
      const ENV_KIND = 'conformance-env'
      const RUNNER_KIND = 'conformance-runner'

      const customEnvBackend: EnvironmentBackendProvider = {
        kind: ENV_KIND,
        displayLabel: 'Conformance Env',
        referencedSecretKeys: () => ['ENV_TOKEN'],
        connectionMeta: (config) => ({
          providerId: ENV_KIND,
          label: 'manifest' in config ? config.manifest.label : 'Conformance Env',
          baseUrl: 'manifest' in config ? config.manifest.baseUrl : '',
        }),
        assertConfigSafe: () => {},
        toManifest: (config) => {
          if (!('manifest' in config)) throw new Error('expected a manifest-shaped custom config')
          return config.manifest
        },
        fromManifest: (manifest) => ({ kind: ENV_KIND, manifest }),
        // A custom ephemeral-environment backend rides the `remote-custom` engine.
        engines: () => ['remote-custom'],
        // describeProvider builds this to read describeConfig (absent here ⇒ no flat fields).
        buildProvider: () => ({
          provision: async () => ({
            externalId: 'e1',
            url: 'https://env.test',
            status: 'ready',
            expiresAt: null,
            access: null,
            fields: {},
          }),
          status: async () => ({
            externalId: 'e1',
            url: 'https://env.test',
            status: 'ready',
            expiresAt: null,
            access: null,
            fields: {},
          }),
          teardown: async () => ({ status: 'torn_down' }),
        }),
      }

      const customRunnerBackend: RunnerBackendProvider = {
        kind: RUNNER_KIND,
        displayLabel: 'Conformance Runner',
        referencedSecretKeys: () => ['POOL_TOKEN'],
        connectionMeta: (config) => ({
          providerId: RUNNER_KIND,
          label: 'manifest' in config ? config.manifest.label : 'Conformance Runner',
          baseUrl: 'manifest' in config ? config.manifest.baseUrl : '',
        }),
        assertConfigSafe: () => {},
        // Never dispatched in this test (the connect/describe/snapshot paths don't build it).
        buildTransport: () => {
          throw new Error('custom runner transport not dispatched in conformance')
        },
        testConnection: async () => ({ ok: true, message: 'ok' }),
      }

      // A code-defined custom PROVISION TYPE (the `custom` catalog half), registered by reference
      // exactly like the backends. It must surface in the handlers bundle's `customTypes` marked
      // `source: 'registered'` so the infra custom-type editor + the per-service provisioning
      // picker can offer it — even with no workspace-defined rows.
      const REGISTERED_TYPE = 'conformance-terraform'

      // The app-owned registries the harness injects, pre-loaded with the built-ins + the two
      // custom backends + the registered custom manifest type — by reference, so the facade sees
      // them regardless of module identity.
      const backendRegistries = createBackendRegistries()
      backendRegistries.environmentBackendRegistry.register(customEnvBackend)
      backendRegistries.runnerBackendRegistry.register(customRunnerBackend)
      backendRegistries.customManifestTypeRegistry.register({
        manifestId: REGISTERED_TYPE,
        label: 'Conformance Terraform',
        description: 'HCL plan + apply',
      })

      const envManifest = {
        providerId: ENV_KIND,
        label: 'Bespoke Envs',
        baseUrl: 'https://bespoke.test/api',
        auth: { type: 'bearer', secretRef: { key: 'ENV_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        providerConfig: { region: 'eu' },
      }
      const runnerManifest = {
        providerId: RUNNER_KIND,
        label: 'Bespoke Pool',
        baseUrl: 'https://bespoke.test/pool',
        auth: { type: 'bearer', secretRef: { key: 'POOL_TOKEN' } },
        dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
        poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
        response: { statusPath: 'state' },
      }

      it('connects + round-trips a custom ENVIRONMENT backend kind through the store', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        const registered = await call<{ kind: string; secretKeys: string[] }>(
          'POST',
          `${base}/connection`,
          { config: { kind: ENV_KIND, manifest: envManifest }, secrets: { ENV_TOKEN: 'tok' } },
        )
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe(ENV_KIND)
        expect(registered.body.secretKeys).toContain('ENV_TOKEN')

        const got = await call<{ connection: { kind: string } | null }>('GET', `${base}/connection`)
        expect(got.body.connection?.kind).toBe(ENV_KIND)

        // The custom kind is describable while connected (and its kind drives the native form).
        const descr = await call<{ kind: string }>('GET', `${base}/provider?kind=${ENV_KIND}`)
        expect(descr.status).toBe(200)
        expect(descr.body.kind).toBe('native')
      })

      it('describes a registered custom kind BEFORE the first connect', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        // No connection yet — the registry still resolves the kind so the SPA can render its form.
        const descr = await call<{ providerId: string; kind: string }>(
          'GET',
          `/workspaces/${workspace.id}/environments/provider?kind=${ENV_KIND}`,
        )
        expect(descr.status).toBe(200)
        expect(descr.body.providerId).toBe(ENV_KIND)
      })

      it('connects + round-trips a custom RUNNER backend kind through the store', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/runner-pool/connection`

        const registered = await call<{ kind: string; secretKeys: string[] }>('POST', base, {
          config: { kind: RUNNER_KIND, manifest: runnerManifest },
          secrets: { POOL_TOKEN: 'tok' },
        })
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe(RUNNER_KIND)

        const got = await call<{ connection: { kind: string; config?: { kind: string } } | null }>(
          'GET',
          base,
        )
        expect(got.body.connection?.kind).toBe(RUNNER_KIND)
        expect(got.body.connection?.config?.kind).toBe(RUNNER_KIND)
      })

      it('advertises the registered backend kinds in the workspace snapshot', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const snap = await call<{
          environmentBackendKinds?: { kind: string }[]
          runnerBackendKinds?: { kind: string }[]
        }>('GET', `/workspaces/${workspace.id}`)
        expect(snap.body.environmentBackendKinds?.map((k) => k.kind)).toEqual(
          expect.arrayContaining(['manifest', 'kubernetes', ENV_KIND]),
        )
        expect(snap.body.runnerBackendKinds?.map((k) => k.kind)).toEqual(
          expect.arrayContaining(['manifest', 'kubernetes', RUNNER_KIND]),
        )
      })

      it('surfaces a programmatically-registered custom manifest type in the handlers bundle', async () => {
        // A code-registered custom provision type must appear in the catalog the SPA reads (the
        // infra custom-type editor + the per-service provisioning picker) WITHOUT any
        // workspace-defined row, marked `source: 'registered'` (read-only). A facade that forgot
        // to wire the `customManifestTypeRegistry` into `createCore` returns an empty catalog here.
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const bundle = await call<{
          customTypes: { manifestId: string; label: string; source: string }[]
        }>('GET', `/workspaces/${workspace.id}/environments/handlers`)
        expect(bundle.status).toBe(200)
        const registered = bundle.body.customTypes.find((t) => t.manifestId === REGISTERED_TYPE)
        expect(registered).toBeDefined()
        expect(registered!.label).toBe('Conformance Terraform')
        expect(registered!.source).toBe('registered')
      })

      it('rejects a config whose kind collides with a reserved built-in (guard)', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        // A `kubernetes` kind carrying a manifest body (the wrong shape) must be REJECTED by
        // the reserved-kind guard, not silently accepted as the generic custom member.
        const res = await call('POST', `/workspaces/${workspace.id}/environments/connection`, {
          config: { kind: 'kubernetes', manifest: envManifest },
          secrets: { ENV_TOKEN: 'tok' },
        })
        expect(res.status).toBeGreaterThanOrEqual(400)
      })
    })

    describe('local model endpoints (per-user runners)', () => {
      it('stores, lists key-free, resolves with the key, and removes — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.localModelEndpoints?.()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (!probe) return
        const userId = `usr_local_${Date.now()}`

        // Upsert an Ollama runner with a bearer key + duplicate model ids.
        const created = await probe.upsert(userId, {
          provider: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'secret-bearer-key',
          models: ['qwen2.5-coder:32b', 'gemma3', 'qwen2.5-coder:32b'],
        })
        expect(created.provider).toBe('ollama')
        expect(created.hasApiKey).toBe(true)
        // The enabled-models JSON round-trips through the store, de-duplicated.
        expect(created.models).toEqual(['qwen2.5-coder:32b', 'gemma3'])

        // The list (wire) shape never leaks the key.
        const listed = await probe.list(userId)
        expect(listed).toHaveLength(1)
        expect(JSON.stringify(listed)).not.toContain('secret-bearer-key')
        expect(listed[0]!.hasApiKey).toBe(true)
        expect(listed[0]!.models).toEqual(['qwen2.5-coder:32b', 'gemma3'])

        // The run-time resolve path decrypts the key (the proxy / inline provider use this).
        const resolved = await probe.resolve(userId, 'ollama')
        expect(resolved?.baseUrl).toBe('http://localhost:11434/v1')
        expect(resolved?.apiKey).toBe('secret-bearer-key')

        // A second, keyless runner resolves with a null key (the common local case).
        await probe.upsert(userId, {
          provider: 'lmstudio',
          baseUrl: 'http://localhost:1234/v1',
          models: ['llama3.3'],
        })
        const both = await probe.list(userId)
        expect(both.map((e) => e.provider).sort()).toEqual(['lmstudio', 'ollama'])
        expect((await probe.resolve(userId, 'lmstudio'))?.apiKey).toBeNull()

        await probe.remove(userId, 'ollama')
        const after = await probe.list(userId)
        expect(after.map((e) => e.provider)).toEqual(['lmstudio'])
      })

      it('rejects a non-local base URL at the write boundary (anti-SSRF) — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.localModelEndpoints?.()
        if (!probe) return
        const userId = `usr_local_ssrf_${Date.now()}`

        // A runner lives on the user's own machine/LAN; the base URL is forwarded
        // server-side, so a public host or the link-local metadata endpoint must be
        // refused before anything is persisted.
        for (const baseUrl of [
          'http://evil.example.com/v1',
          'http://169.254.169.254/latest/meta-data',
          'http://8.8.8.8/v1',
        ]) {
          await expect(
            probe.upsert(userId, { provider: 'custom', baseUrl, models: ['m'] }),
          ).rejects.toThrow()
        }
        // Nothing was stored.
        expect(await probe.list(userId)).toEqual([])

        // A loopback URL is still accepted.
        const ok = await probe.upsert(userId, {
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:8080/v1',
          models: ['m'],
        })
        expect(ok.provider).toBe('custom')
        await probe.remove(userId, 'custom')
      })
    })

    describe('user secrets (per-user GitHub PAT)', () => {
      it('stores the secret system-encrypted, resolves it, and describes the kind — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.userSecrets?.()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (!probe) return
        const userId = `usr_secret_${Date.now()}`

        const stored = await probe.store(userId, 'github_pat', {
          secret: 'ghp_token_123',
          metadata: { apiBase: 'https://ghe.example/api/v3' },
        })
        expect(stored.kind).toBe('github_pat')
        expect(stored.hasSecret).toBe(true)
        expect(stored.metadata).toEqual({ apiBase: 'https://ghe.example/api/v3' })
        // The status never leaks the raw secret.
        expect(JSON.stringify(stored)).not.toContain('ghp_token_123')

        // The run-time resolve path (ResolveUserGitHubToken) decrypts the system-key secret.
        expect(await probe.resolve(userId, 'github_pat')).toBe('ghp_token_123')
        // Absent for another user.
        expect(await probe.resolve(`${userId}_other`, 'github_pat')).toBeNull()

        // The kind self-describes a single secret field + a connection test.
        const descriptor = probe.describe('github_pat')
        expect(descriptor?.supportsTest).toBe(true)
        expect(descriptor?.configFields.find((f) => f.secret)?.key).toBe('token')
      })

      it('resolves a deployment-registered custom kind through the injected app-owned registry — on every runtime', async () => {
        // The secret-kind registry is app-owned (no module-global Map): a deployment
        // registers a custom kind BY REFERENCE into the registry the harness injects via
        // `makeApp({ backendRegistries })`, so the facade's UserSecretService describes it
        // regardless of module identity — the migration's whole point. See
        // `docs/initiatives/registry-di-migration.md`.
        const backendRegistries = createBackendRegistries()
        backendRegistries.userSecretKindRegistry.register({
          kind: 'conformance-secret',
          label: 'Conformance secret',
          configFields: [{ key: 'token', label: 'Token', secret: true, required: true }],
        })
        const app = harness.makeApp(undefined, { backendRegistries })
        const probe = app.userSecrets?.()
        if (!probe) return

        // The injected custom kind is describable...
        const custom = probe.describe('conformance-secret')
        expect(custom?.kind).toBe('conformance-secret')
        expect(custom?.supportsTest).toBe(false)
        expect(custom?.configFields.find((f) => f.secret)?.key).toBe('token')
        // ...and the built-in still resolves off the SAME registry instance.
        expect(probe.describe('github_pat')?.supportsTest).toBe(true)
      })
    })

    describe('private package registries (per-workspace npm/GitHub-Packages auth)', () => {
      it('adds, lists redacted, resolves decrypted for dispatch, and removes — identically per store', async () => {
        const app = harness.makeApp()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        const probe = app.packageRegistries?.()
        if (!probe) return
        const { workspace } = await app.createWorkspace()
        const base = `/workspaces/${workspace.id}/package-registries`

        const empty = await app.call<{ entries: unknown[] }>('GET', base)
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        // Add one entry per vendor. The list view is REDACTED: vendor + scopes + token
        // tail only — the raw token must never appear on the wire.
        const added = await app.call<{
          entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
        }>('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['@acme'],
          token: 'npm_secret_token_1234',
        })
        expect(added.status).toBe(200)
        const listed = await app.call<{
          entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
        }>('POST', base, {
          ecosystem: 'npm',
          vendor: 'github-packages',
          scopes: ['@acme-internal', '@acme-tools'],
          token: 'ghp_registry_secret_5678',
        })
        expect(listed.status).toBe(200)
        expect(listed.body.entries).toHaveLength(2)
        const [npmjs, ghp] = listed.body.entries
        expect(npmjs?.vendor).toBe('npmjs')
        expect(npmjs?.scopes).toEqual(['@acme'])
        expect(npmjs?.tokenTail).toBe('1234')
        expect(ghp?.vendor).toBe('github-packages')
        expect(JSON.stringify(listed.body)).not.toContain('npm_secret_token_1234')
        expect(JSON.stringify(listed.body)).not.toContain('ghp_registry_secret_5678')

        // A second entry for an already-configured vendor is a 409: the harness renders one
        // host-keyed `_authToken` per registry, so a duplicate would be silently dropped.
        const dup = await app.call('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['@acme-extra'],
          token: 'npm_second_token_9999',
        })
        expect(dup.status).toBe(409)

        // A malformed scope is rejected at the write boundary.
        const bad = await app.call('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['not-a-scope!'],
          token: 'x_token_x',
        })
        expect(bad.status).toBeGreaterThanOrEqual(400)

        // The dispatch path decrypts the sealed entries and derives the vendor host —
        // this is what rides the container job body as `packageRegistries`.
        const dispatch = await probe.resolveForDispatch(workspace.id)
        expect(dispatch).toEqual([
          {
            ecosystem: 'npm',
            host: 'registry.npmjs.org',
            scopes: ['@acme'],
            token: 'npm_secret_token_1234',
          },
          {
            ecosystem: 'npm',
            host: 'npm.pkg.github.com',
            scopes: ['@acme-internal', '@acme-tools'],
            token: 'ghp_registry_secret_5678',
          },
        ])
        // A workspace with no connection dispatches nothing (no error).
        const other = await app.createWorkspace()
        expect(await probe.resolveForDispatch(other.workspace.id)).toEqual([])

        // Remove both entries; the second removal deletes the row outright.
        const firstId = listed.body.entries[0]?.id as string
        const secondId = listed.body.entries[1]?.id as string
        expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(204)
        // Removing an unknown entry 404s rather than silently succeeding.
        expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(404)
        expect((await app.call('DELETE', `${base}/${secondId}`)).status).toBe(204)
        const cleared = await app.call<{ entries: unknown[] }>('GET', base)
        expect(cleared.body.entries).toEqual([])
        expect(await probe.resolveForDispatch(workspace.id)).toEqual([])
      })
    })

    describe('sensitive per-service test credentials (sealed)', () => {
      it('seals values, lists redacted refs, and removes — identically per store', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace({ seed: true })
        // Key by a demo-board block (the inspector edits a service frame; CRUD is exact-keyed
        // by block id, so any seeded block id exercises the same store round-trip).
        const base = `/workspaces/${workspace.id}/services/blk_auth/test-secrets`

        const empty = await app.call<{ blockId: string; entries: unknown[] }>('GET', base)
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (empty.status === 503) return
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        // Seal two secrets. The view is REDACTED: key + description only — the VALUE must
        // never appear on the wire (it is sealed at rest and delivered out of band).
        const set = await app.call<{
          blockId: string
          entries: { key: string; description: string }[]
        }>('PUT', base, {
          entries: [
            {
              key: 'STRIPE_API_KEY',
              description: 'Stripe test-mode secret key',
              value: 'sk_test_SECRET_VALUE_1',
            },
            {
              key: 'SENDGRID_TOKEN',
              description: 'SendGrid sandbox token',
              value: 'SG.SECRET_VALUE_2',
            },
          ],
        })
        expect(set.status).toBe(200)
        expect(set.body.entries.map((e) => e.key)).toEqual(['STRIPE_API_KEY', 'SENDGRID_TOKEN'])
        expect(JSON.stringify(set.body)).not.toContain('sk_test_SECRET_VALUE_1')
        expect(JSON.stringify(set.body)).not.toContain('SG.SECRET_VALUE_2')

        const listed = await app.call<{ entries: { key: string; description: string }[] }>(
          'GET',
          base,
        )
        expect(listed.status).toBe(200)
        expect(listed.body.entries).toEqual([
          { key: 'STRIPE_API_KEY', description: 'Stripe test-mode secret key' },
          { key: 'SENDGRID_TOKEN', description: 'SendGrid sandbox token' },
        ])
        expect(JSON.stringify(listed.body)).not.toContain('SECRET_VALUE')

        // A duplicate key is rejected at the write boundary (keys are unique per service).
        const dup = await app.call('PUT', base, {
          entries: [
            { key: 'STRIPE_API_KEY', description: 'a', value: 'x1' },
            { key: 'STRIPE_API_KEY', description: 'b', value: 'x2' },
          ],
        })
        expect(dup.status).toBeGreaterThanOrEqual(400)

        // A non-env-var key is rejected too.
        const badKey = await app.call('PUT', base, {
          entries: [{ key: '1-bad key', description: 'nope', value: 'x' }],
        })
        expect(badKey.status).toBeGreaterThanOrEqual(400)

        // A reserved/toolchain env-var name (would clobber the harness environment) is rejected
        // at the write boundary, not silently dropped at injection.
        const reserved = await app.call('PUT', base, {
          entries: [{ key: 'PATH', description: 'nope', value: 'x' }],
        })
        expect(reserved.status).toBeGreaterThanOrEqual(400)

        // Replacing with an empty set removes the row; the view is empty again.
        const cleared = await app.call<{ entries: unknown[] }>('PUT', base, { entries: [] })
        expect(cleared.status).toBe(200)
        expect(cleared.body.entries).toEqual([])
        expect((await app.call('DELETE', base)).status).toBe(204)
        expect((await app.call<{ entries: unknown[] }>('GET', base)).body.entries).toEqual([])
      })
    })

    describe('repo bootstrap', () => {
      it('round-trips reference architectures', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/bootstrap/reference-architectures`

        const empty = await call<unknown[]>('GET', base)
        expect(empty.status).toBe(200)
        expect(empty.body).toEqual([])

        const created = await call<{ id: string; name: string }>('POST', base, {
          name: 'Node service',
          repoOwner: 'acme',
          repoName: 'reference-node',
          defaultInstructions: 'Adapt the reference service.',
        })
        expect(created.status).toBe(201)
        expect(created.body.name).toBe('Node service')

        const renamed = await call<{ name: string }>('PATCH', `${base}/${created.body.id}`, {
          name: 'Node service v2',
        })
        expect(renamed.status).toBe(200)
        expect(renamed.body.name).toBe('Node service v2')

        const listed = await call<{ id: string }[]>('GET', base)
        expect(listed.body.map((r) => r.id)).toEqual([created.body.id])

        const del = await call('DELETE', `${base}/${created.body.id}`)
        expect(del.status).toBe(204)
        expect((await call<unknown[]>('GET', base)).body).toEqual([])
      })

      it('drives a bootstrap run to success and materialises its service frame', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Kick off a from-scratch bootstrap (the FakeRepoBootstrapper reports connected,
        // so the pre-flight passes). The call returns immediately with a running job that
        // already carries its provisional service frame.
        const started = await app.call<{ id: string; status: string; blockId: string | null }>(
          'POST',
          `/workspaces/${wsId}/bootstrap/jobs`,
          { repoName: 'new-service', instructions: 'Scaffold a small HTTP service.' },
        )
        expect(started.status).toBe(201)
        expect(started.body.status).toBe('running')
        expect(started.body.blockId).toBeTruthy()
        const jobId = started.body.id
        const frameId = started.body.blockId!

        // Drive the durable poll loop (production: pg-boss / a BootstrapWorkflow). The
        // default fake reports `done` on the first poll.
        const polls = await app.driveBootstrap(wsId, jobId)
        expect(polls).toBeGreaterThanOrEqual(1)

        // The job is now succeeded and its service frame is materialised on the board
        // (a real frame, not blocked — the success path flips it ready, after which the
        // best-effort initial blueprint run may move it to in_progress; both are success
        // states and identical across facades, so we assert it isn't the failure state).
        const job = await app.call<{ status: string; blockId: string | null }>(
          'GET',
          `/workspaces/${wsId}/bootstrap/jobs/${jobId}`,
        )
        expect(job.body.status).toBe('succeeded')

        const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const frame = snap.body.blocks.find((b) => b.id === frameId)
        expect(frame?.level).toBe('frame')
        expect(frame?.status).not.toBe('blocked')
      })
    })

    describe('task sources', () => {
      it('creates a board task from an imported issue and links the issue to it', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A service frame to create the task inside.
        const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
          type: 'service',
          position: { x: 0, y: 0 },
        })
        expect(frame.status).toBe(201)

        // Connect + import the issue (the fake provider accepts any credentials and
        // generates a deterministic issue), then materialise it as a board task.
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        await call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-42' })

        const created = await call<{ block: Block; task: SourceTask }>(
          'POST',
          `/workspaces/${ws}/tasks/create-block`,
          { source: 'jira', externalId: 'PROJ-42', containerId: frame.body.id },
        )
        expect(created.status).toBe(201)

        // The new block is a leaf task under the frame, seeded from the issue.
        const block = created.body.block
        expect(block.level).toBe('task')
        expect(block.parentId).toBe(frame.body.id)
        expect(block.title).toContain('PROJ-42')
        expect(block.description).toContain('Description for PROJ-42')
        expect(block.status).toBe('planned')

        // The issue is linked to the new task for context, and it's persisted: the
        // board snapshot includes it and the issue list reflects the link.
        expect(created.body.task.linkedBlockId).toBe(block.id)
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
        expect(snapshot.body.blocks.some((b) => b.id === block.id && b.level === 'task')).toBe(true)
        const issues = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
        expect(issues.body.find((t) => t.externalId === 'PROJ-42')?.linkedBlockId).toBe(block.id)

        // Creating a second task from the already-linked issue is refused (409), so the
        // single issue→block link is never silently re-pointed away from the first task.
        const again = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
          source: 'jira',
          externalId: 'PROJ-42',
          containerId: frame.body.id,
        })
        expect(again.status).toBe(409)
      })

      it('404s when the issue was never imported', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id
        const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
          type: 'service',
          position: { x: 0, y: 0 },
        })

        const res = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
          source: 'jira',
          externalId: 'PROJ-999',
          containerId: frame.body.id,
        })
        expect(res.status).toBe(404)
      })

      it('toggles a source off per workspace, gating import, and persists the toggle', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A connected source starts available + enabled (offered).
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        const before = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const jiraBefore = before.body.sources.find((s) => s.source === 'jira')
        expect(jiraBefore?.available).toBe(true)
        expect(jiraBefore?.enabled).toBe(true)

        // Disabling it is refused-from-use and reflected on the source state (persisted).
        const off = await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, {
          enabled: false,
        })
        expect(off.status).toBe(204)
        const after = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        expect(after.body.sources.find((s) => s.source === 'jira')?.enabled).toBe(false)
        const blocked = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
          ref: 'PROJ-7',
        })
        expect(blocked.status).toBe(409)

        // Re-enabling restores import.
        await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, { enabled: true })
        const ok = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
          ref: 'PROJ-7',
        })
        expect(ok.status).toBe(201)
      })

      it('runs a live setup-check, gating on connection then delegating to the provider', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A credentialed source with no connection yet reports `not_connected` —
        // the service gates on availability before it would ever probe.
        const before = await call<TaskSourceDiagnostic>(
          'POST',
          `/workspaces/${ws}/task-sources/jira/diagnostics`,
        )
        expect(before.status).toBe(200)
        expect(before.body.ok).toBe(false)
        expect(before.body.status).toBe('not_connected')

        // Once connected, the check delegates to the provider's live probe (the fake
        // returns a ready verdict), so a configured source reports ready.
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        const after = await call<TaskSourceDiagnostic>(
          'POST',
          `/workspaces/${ws}/task-sources/jira/diagnostics`,
        )
        expect(after.status).toBe(200)
        expect(after.body.ok).toBe(true)
        expect(after.body.status).toBe('ready')
      })

      it('wires Linear as a task source on every facade (registered, connect, import-gated)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // Linear is registered symmetrically across runtimes: it shows up in the source
        // list (so the connect UI offers it), connects with a personal API key, and lists
        // back available + enabled — the same lifecycle as Jira, proving the wiring.
        const listed = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        expect(listed.body.sources.some((s) => s.source === 'linear')).toBe(true)

        const connected = await call<{ source: string }>(
          'POST',
          `/workspaces/${ws}/task-sources/linear/connect`,
          { credentials: { apiKey: 'lin_api_secret_key_123' } },
        )
        expect(connected.status).toBe(201)
        expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

        const after = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const linear = after.body.sources.find((s) => s.source === 'linear')
        expect(linear?.available).toBe(true)
        expect(linear?.enabled).toBe(true)
      })

      it('wires the Linear OAuth + team-picker routes on every facade', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // The descriptor advertises the OAuth connect option (the SPA shows the
        // "Connect with Linear" button), in addition to the manual API-key field.
        const listed = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const linear = listed.body.sources.find((s) => s.source === 'linear')
        expect(linear?.oauth).toBe(true)

        // The install-url route is wired but reports 503 until the deployment configures
        // a Linear OAuth app (the conformance harness leaves it unconfigured).
        const installUrl = await call('GET', `/workspaces/${ws}/task-sources/linear/install-url`)
        expect(installUrl.status).toBe(503)

        // The team-picker route is wired; with no Linear connection it refuses (409)
        // rather than 404 — proving the route exists symmetrically on both runtimes.
        const teams = await call('GET', `/workspaces/${ws}/task-sources/linear/teams`)
        expect(teams.status).toBe(409)
      })
    })

    describe('document sources', () => {
      // GitHub docs are an IMPLICIT connection: they ride the workspace's installed GitHub
      // App/PAT, so a facade that carries an installation (local mode always does, via its
      // GITHUB_PAT) surfaces `github` in every workspace's connection list with no stored
      // row — while a facade with no installation (Node/Worker here) does not. These
      // credentialed-source lifecycle assertions are orthogonal to that, so compare on the
      // EXPLICITLY-connected (non-github) sources to stay correct on both kinds of facade.
      // The implicit path itself is covered by the DocumentConnectionService /
      // GitHubDocsProvider unit tests.
      const explicit = (connections: { source: string }[]) =>
        connections.map((c) => c.source).filter((s) => s !== 'github')

      it('connects, lists (secret-free), and disconnects a document source', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // The module is wired on every facade: a fresh workspace lists no connections
        // (a 200), not the 503 a missing documents module would return.
        const initial = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(initial.status).toBe(200)
        expect(explicit(initial.body.connections)).toEqual([])

        // Connect Notion (a single internal-integration token; normalizeConnection is
        // pure, so no network). The credential is encrypted at rest and never echoed.
        const connected = await call<{ source: string; label: string }>(
          'POST',
          `${base}/notion/connect`,
          { credentials: { apiToken: 'secret-notion-token-xyz' } },
        )
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('notion')
        expect(JSON.stringify(connected.body)).not.toContain('secret-notion-token')

        // It lists back as metadata only — the token is never on the wire.
        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(listed.body.connections)).toEqual(['notion'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-notion-token')

        // Disconnect tombstones it; the list goes empty again.
        const del = await call('DELETE', `${base}/notion/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(afterDelete.body.connections)).toEqual([])
      })

      it('connects, lists (secret-free), and disconnects Figma (per-workspace PAT)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Figma is wired on every facade beside Notion/Confluence (a per-workspace PAT;
        // normalizeConnection is pure, so no network). The token never leaves the backend.
        const connected = await call<{ source: string; label: string }>(
          'POST',
          `${base}/figma/connect`,
          { credentials: { apiToken: 'figd_secret-figma-token-xyz' } },
        )
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('figma')
        expect(JSON.stringify(connected.body)).not.toContain('secret-figma-token')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(listed.body.connections)).toEqual(['figma'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-figma-token')

        const del = await call('DELETE', `${base}/figma/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(afterDelete.body.connections)).toEqual([])
      })

      it('wires Linear as a document source on every facade (connect, list, disconnect)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Linear is registered symmetrically across runtimes: a personal API key
        // connects, lists back as metadata only, and disconnects — the same lifecycle
        // as Notion, proving the provider is wired (not 503/404) on this facade.
        const connected = await call<{ source: string }>('POST', `${base}/linear/connect`, {
          credentials: { apiKey: 'lin_api_secret_key_123' },
        })
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('linear')
        expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(listed.body.connections)).toEqual(['linear'])
        expect(JSON.stringify(listed.body)).not.toContain('lin_api_secret_key_123')

        const del = await call('DELETE', `${base}/linear/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(afterDelete.body.connections)).toEqual([])
      })

      it('connects, lists (secret-free), and disconnects Zeplin (per-workspace PAT)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Zeplin is the second design source, wired on every facade beside Figma (a
        // per-workspace Bearer PAT; normalizeConnection is pure, so no network). It proves
        // the design abstraction is not Figma-shaped — a different content model (screens +
        // a handoff design system) rides the same provider port. The token never leaves the
        // backend.
        const connected = await call<{ source: string }>('POST', `${base}/zeplin/connect`, {
          credentials: { apiToken: 'zpn-secret-zeplin-token-xyz' },
        })
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('zeplin')
        expect(JSON.stringify(connected.body)).not.toContain('secret-zeplin-token')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(listed.body.connections)).toEqual(['zeplin'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-zeplin-token')

        const del = await call('DELETE', `${base}/zeplin/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(explicit(afterDelete.body.connections)).toEqual([])
      })

      it('persists workspace+DocKind template (singular) and exemplar (multi) role links', async () => {
        // WS1 items 2–4: the role-tagged document links a workspace attaches to a DocKind. The
        // link WRITE path needs an imported document row (import needs a live source the dev-open
        // HTTP path can't reach), so drive the persistence through the repository probe — asserting
        // template singular-replace, exemplar multi, the management list, and the parsed-template
        // override behave identically on D1 and Postgres.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        const repo = app.documentRepository()
        const doc = (externalId: string, title: string, body: string): DocumentRecord => ({
          workspaceId: ws,
          source: 'github',
          externalId,
          title,
          url: `https://github.com/o/r/blob/HEAD/${externalId}`,
          excerpt: '',
          body,
          contentHash: '',
          linkedBlockId: null,
          role: null,
          docKind: null,
          syncedAt: 1_000,
          deletedAt: null,
        })
        await repo.upsert(
          doc(
            'docs/templates/rfc-a.md',
            'RFC template A',
            '# RFC\n\n## Summary\n\n## Motivation\n\n## Rollout',
          ),
        )
        await repo.upsert(
          doc('docs/templates/rfc-b.md', 'RFC template B', '# RFC\n\n## Abstract\n\n## Design'),
        )
        await repo.upsert(
          doc('docs/examples/good-rfc.md', 'A great RFC', '# Example RFC\n\n## Summary'),
        )

        // Link A as the rfc template.
        await repo.clearRoleForKind(ws, 'template', 'rfc')
        await repo.setRole(ws, 'github', 'docs/templates/rfc-a.md', 'template', 'rfc')
        const tplA = await repo.getRoleLink(ws, 'template', 'rfc')
        expect(tplA?.externalId).toBe('docs/templates/rfc-a.md')
        // The linked template's parsed sections become the kind's effective template — the SAME
        // override the doc-quality gate resolves, so the writer and gate never disagree.
        expect(resolveDocTemplate('rfc', tplA!.body).sections.map((s) => s.title)).toEqual([
          'Summary',
          'Motivation',
          'Rollout',
        ])

        // Relinking a new template for the kind REPLACES the prior one (singular per kind).
        await repo.clearRoleForKind(ws, 'template', 'rfc')
        await repo.setRole(ws, 'github', 'docs/templates/rfc-b.md', 'template', 'rfc')
        expect((await repo.getRoleLink(ws, 'template', 'rfc'))?.externalId).toBe(
          'docs/templates/rfc-b.md',
        )
        expect((await repo.get(ws, 'github', 'docs/templates/rfc-a.md'))?.role).toBeNull()

        // Exemplars are additive (multi-valued per kind).
        await repo.setRole(ws, 'github', 'docs/examples/good-rfc.md', 'exemplar', 'rfc')
        expect((await repo.listRoleLinks(ws, 'exemplar', 'rfc')).map((d) => d.externalId)).toEqual([
          'docs/examples/good-rfc.md',
        ])

        // The management list surfaces every role-tagged document (template + exemplars).
        const all = await repo.listRoleLinksByWorkspace(ws)
        expect(new Set(all.map((d) => `${d.role}:${d.externalId}`))).toEqual(
          new Set(['template:docs/templates/rfc-b.md', 'exemplar:docs/examples/good-rfc.md']),
        )

        // Unlinking clears the tag — the built-in template resumes for the kind.
        await repo.clearRole(ws, 'github', 'docs/templates/rfc-b.md')
        expect(await repo.getRoleLink(ws, 'template', 'rfc')).toBeNull()
      })

      it('persists an interactive document-interview session identically (WS5)', async () => {
        // The interactive-interview session (WS5) is written by the interviewer LLM (off in
        // conformance), so — like the role-link probe above — exercise the persistence through
        // the repository directly. Asserting upsert / getByBlock-newest-wins / get / deleteByBlock
        // here means a facade that maps a column differently (D1 vs Drizzle) fails a shared test.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        const repo = app.docInterviewRepository()

        // A fresh block has no session.
        expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()

        // Round-trip an `awaiting` session with a pending question.
        await repo.upsert(ws, {
          id: 'dis-1',
          blockId: 'task_doc',
          status: 'awaiting',
          round: 1,
          maxRounds: 4,
          qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: '' }],
          brief: null,
          model: 'openai:gpt',
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        const loaded = await repo.getByBlock(ws, 'task_doc')
        expect(loaded?.status).toBe('awaiting')
        expect(loaded?.round).toBe(1)
        expect(loaded?.qa).toEqual([{ id: 'diq-1', question: 'Who is the audience?', answer: '' }])
        expect(await repo.get(ws, 'dis-1')).not.toBeNull()

        // An upsert on the same id converges it (answered digest + synthesized brief).
        await repo.upsert(ws, {
          id: 'dis-1',
          blockId: 'task_doc',
          status: 'done',
          round: 2,
          maxRounds: 4,
          qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: 'Platform engineers' }],
          brief: '# Authoring brief\n\nWrite for platform engineers.',
          model: 'openai:gpt',
          createdAt: 1_000,
          updatedAt: 2_000,
        })
        const done = await repo.getByBlock(ws, 'task_doc')
        expect(done?.status).toBe('done')
        expect(done?.brief).toContain('platform engineers')
        expect(done?.qa[0]?.answer).toBe('Platform engineers')

        // deleteByBlock clears the block's session(s).
        await repo.deleteByBlock(ws, 'task_doc')
        expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()
      })

      it('batch-resolves imported issues by (source, externalId) ref (listByRefs)', async () => {
        // The engine resolves the tracker issues a task's description names explicitly via a
        // single batched read (AgentContextBuilder → TaskRepository.listByRefs), never a
        // point-read per reference (an N+1). The import WRITE path needs a live source the
        // dev-open HTTP `call` path can't reach, so exercise the read through the repository
        // directly — asserting the chunked-`IN`-per-source batch behaves identically on D1 and
        // Postgres (a facade that mapped a column or the source filter differently fails here).
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        const repo = app.taskRepository()
        const task = (source: TaskRecord['source'], externalId: string): TaskRecord => ({
          workspaceId: ws,
          source,
          externalId,
          title: `Issue ${externalId}`,
          url: `https://tracker/${externalId}`,
          status: 'open',
          type: 'Story',
          assignee: null,
          priority: null,
          labels: [],
          description: `Body of ${externalId}`,
          comments: [],
          excerpt: '',
          linkedBlockId: null,
          syncedAt: 1_000,
          deletedAt: null,
        })
        await repo.upsert(task('jira', 'PROJ-1'))
        await repo.upsert(task('jira', 'PROJ-2'))
        await repo.upsert(task('github', 'octo/repo#7'))

        // Empty input is a no-op (no query issued).
        expect(await repo.listByRefs(ws, [])).toEqual([])

        // A mixed set spanning both sources resolves only the rows that exist; a matching
        // key under the WRONG source (PROJ-1 as github) and an absent key resolve to nothing.
        const resolved = await repo.listByRefs(ws, [
          { source: 'jira', externalId: 'PROJ-1' },
          { source: 'jira', externalId: 'MISSING-9' },
          { source: 'github', externalId: 'octo/repo#7' },
          { source: 'github', externalId: 'PROJ-1' },
        ])
        expect(new Set(resolved.map((t) => `${t.source}:${t.externalId}`))).toEqual(
          new Set(['jira:PROJ-1', 'github:octo/repo#7']),
        )
        // Full records come back (not just keys), so the caller renders bodies without re-reading.
        expect(resolved.find((t) => t.externalId === 'PROJ-1')?.description).toBe('Body of PROJ-1')
      })
    })

    describe('ephemeral environments', () => {
      it('registers, reads (secret-free), and unregisters an environment provider', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        // The module is wired on every facade (the test env opts in): a fresh
        // workspace has no provider connection — a 200, not the 503 a missing module
        // would return.
        const initial = await call<{ connection: unknown }>('GET', `${base}/connection`)
        expect(initial.status).toBe(200)
        expect(initial.body.connection).toBeNull()

        // Register a provider (a declarative manifest + its secret bundle). register is
        // pure — it validates the manifest (SSRF + secret completeness) and encrypts the
        // bundle at rest; no network. The token is never echoed.
        const manifest = {
          providerId: 'acme-envs',
          label: 'Acme Ephemeral Envs',
          baseUrl: 'https://envs.test/api',
          auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
          provision: {
            method: 'POST',
            pathTemplate: '/environments',
            bodyTemplate: '{"ref":"{{input.blockId}}"}',
          },
          status: { method: 'GET', pathTemplate: '/environments/{{provision.externalId}}' },
          teardown: { method: 'DELETE', pathTemplate: '/environments/{{provision.externalId}}' },
          response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        }
        const registered = await call<{ providerId: string; secretKeys: string[] }>(
          'POST',
          `${base}/connection`,
          {
            config: { kind: 'manifest', manifest },
            secrets: { API_TOKEN: 'super-secret-env-token' },
          },
        )
        expect(registered.status).toBe(201)
        expect(registered.body.providerId).toBe('acme-envs')
        expect(registered.body.secretKeys).toEqual(['API_TOKEN'])
        expect(JSON.stringify(registered.body)).not.toContain('super-secret-env-token')

        // It reads back as metadata only — the secret bundle is never on the wire.
        const got = await call<{ connection: { providerId: string; secretKeys: string[] } | null }>(
          'GET',
          `${base}/connection`,
        )
        expect(got.body.connection?.providerId).toBe('acme-envs')
        expect(got.body.connection?.secretKeys).toEqual(['API_TOKEN'])
        expect(JSON.stringify(got.body)).not.toContain('super-secret-env-token')

        // Unregister tombstones it; the connection goes null again.
        const del = await call('DELETE', `${base}/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connection: unknown }>('GET', `${base}/connection`)
        expect(afterDelete.body.connection).toBeNull()
      })

      it('round-trips a Kubernetes backend connection (kind + discriminated config)', async () => {
        // The env-backend registry mirrors the runner pool: a `kind` discriminator selects
        // the provider, and the K8s config rides the stored manifest's providerConfig. This
        // must persist + read back identically on D1 and Postgres — a repo that dropped the
        // `kind` column or mangled the config JSON diverges here. No custom CA, so it also
        // passes the Worker's `customTlsSupported: false` guard.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`
        const config = {
          kind: 'kubernetes',
          kubernetes: {
            label: 'k3s',
            apiServerUrl: 'https://cluster.example:6443',
            manifestSource: { type: 'colocated', path: 'k8s' },
            url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
          },
        }
        const registered = await call<{
          kind: string
          providerId: string
          secretKeys: string[]
          config?: { kind: string }
        }>('POST', `${base}/connection`, { config, secrets: { apiToken: 'sa-token' } })
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe('kubernetes')
        expect(registered.body.providerId).toBe('kubernetes')
        expect(registered.body.secretKeys).toEqual(['apiToken'])
        expect(registered.body.config?.kind).toBe('kubernetes')
        expect(JSON.stringify(registered.body)).not.toContain('sa-token')

        const got = await call<{
          connection: {
            kind: string
            config?: { kubernetes?: { apiServerUrl: string } }
          } | null
        }>('GET', `${base}/connection`)
        expect(got.body.connection?.kind).toBe('kubernetes')
        expect(got.body.connection?.config?.kubernetes?.apiServerUrl).toBe(
          'https://cluster.example:6443',
        )
      })

      it('round-trips a Docker Compose backend connection on every facade', async () => {
        // The Docker Compose env backend rides the generic manifest member (no typed variant,
        // no migration): its flat config lives in the stored manifest's `providerConfig`. It is
        // a runtime-bound backend (needs a Docker daemon, so only local/Node register it by
        // default), but its CONNECTION persistence is runtime-neutral and must read back
        // identically — a repo that mangled `providerConfig` in the manifest JSON column, or a
        // facade that didn't open its env-connection store to the `compose` kind, diverges here.
        // Registered by reference with a fake runtime (never invoked on the connect/describe
        // paths) so the assertion needs no real daemon.
        // The fake runtime carries the optional build-mode `checkout`/`writeCheckoutFile` seam too
        // (recorded, never invoked on the connect/describe paths asserted here) — it composes the
        // same way the real local runtime does, and the build config below must persist regardless.
        const checkouts: { cloneUrl: string; ref: string }[] = []
        const fakeRuntime: ComposeRuntime = {
          compose: async () => ({ code: 0, stdout: '', stderr: '' }),
          writeProjectFile: async () => '',
          checkout: async (_project, target) => {
            checkouts.push({ cloneUrl: target.cloneUrl, ref: target.ref })
            return { dir: '/tmp/checkout' }
          },
          writeCheckoutFile: async () => '',
        }
        const backendRegistries = createBackendRegistries()
        backendRegistries.environmentBackendRegistry.register(
          composeEnvironmentBackend(fakeRuntime),
        )

        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`
        const manifest = {
          providerId: 'compose',
          label: 'Docker Compose',
          baseUrl: 'http://localhost',
          auth: { type: 'none' },
          provision: { method: 'POST', pathTemplate: '' },
          response: {},
          // Build-from-source config: the `build` flag + build timeout must survive the manifest
          // JSON column round-trip identically on both stores (D1 ⇄ Drizzle).
          providerConfig: {
            service: 'web',
            port: '8080',
            composePath: 'docker-compose.yml',
            build: 'true',
            buildTimeoutMinutes: '20',
          },
        }
        const registered = await call<{ kind: string; providerId: string; secretKeys: string[] }>(
          'POST',
          `${base}/connection`,
          { config: { kind: 'compose', manifest }, secrets: {} },
        )
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe('compose')
        expect(registered.body.providerId).toBe('compose')
        expect(registered.body.secretKeys).toEqual([])

        const got = await call<{
          connection: {
            kind: string
            config?: { manifest?: { providerConfig?: { service?: string; build?: string } } }
          } | null
        }>('GET', `${base}/connection`)
        expect(got.body.connection?.kind).toBe('compose')
        expect(got.body.connection?.config?.manifest?.providerConfig?.service).toBe('web')
        // The build-mode flag round-trips through the store on every facade.
        expect(got.body.connection?.config?.manifest?.providerConfig?.build).toBe('true')

        // Advertised in the snapshot so the SPA lists it (with its when-to-use guidance).
        const snap = await call<{ environmentBackendKinds?: { kind: string }[] }>(
          'GET',
          `/workspaces/${workspace.id}`,
        )
        expect(snap.body.environmentBackendKinds?.map((k) => k.kind)).toEqual(
          expect.arrayContaining(['compose']),
        )

        // The descriptor-driven connect form exposes the flat fields (service + port required) +
        // the build-from-source selector, so the build toggle ships on every facade's connect UI.
        const descr = await call<{ kind: string; configFields: { key: string }[] }>(
          'GET',
          `${base}/provider?kind=compose`,
        )
        expect(descr.status).toBe(200)
        expect(descr.body.configFields.map((f) => f.key)).toEqual(
          expect.arrayContaining(['service', 'port', 'build']),
        )
        // Registering + describing a build-mode connection must never clone (a clone only happens
        // when a run actually provisions the env).
        expect(checkouts).toHaveLength(0)
      })

      it('surfaces a deployer EnvironmentProvider failure as an `environment` run failure on every facade', async () => {
        // Parity for the deployer spin-up surfacing (PR #446): when a `deployer` step's
        // EnvironmentProvider fails to provision, the engine must record an `environment`
        // run failure carrying the provider's verbatim error AND persist a `failed`
        // EnvironmentRecord that projects back onto the step (`step.environment.lastError`)
        // — not a green step with the error buried in prose. The failed-record round-trip
        // crosses each facade's own registry repo (D1 ⇄ Drizzle), so a runtime that maps
        // the `failed`/`lastError` columns differently — or forgot to wire the failed-record
        // persistence — diverges here instead of shipping silently.
        const provider = {
          provision: async () => {
            throw new Error('env API unreachable: ECONNREFUSED')
          },
          status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
          teardown: async () => ({ status: 'torn_down' }) as never,
        }
        const app = harness.makeApp(undefined, {
          environmentProvider: provider as unknown as EnvironmentProvider,
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A registered connection gives `provision` its manifest, so the call reaches the
        // (throwing) provider rather than failing earlier on "no connection".
        const manifest = {
          providerId: 'acme-envs',
          label: 'Acme Ephemeral Envs',
          baseUrl: 'https://envs.test/api',
          auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
          provision: { method: 'POST', pathTemplate: '/environments' },
          response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        }
        const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
          config: { kind: 'manifest', manifest },
          secrets: { API_TOKEN: 'super-secret-env-token' },
        })
        expect(registered.status).toBe(201)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Deploy only',
          agentKinds: ['deployer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        // A real, classified `environment` failure carrying the provider's verbatim error —
        // not a generic run failure, and not a falsely-green step.
        expect(exec.status).toBe('failed')
        expect(exec.failure?.kind).toBe('environment')
        expect(exec.failure?.detail).toContain('ECONNREFUSED')
        const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
        expect(deployStep.state).not.toBe('done')
        // The failure is attributed to the in-flight step (the deployer), so the step-detail
        // overlay can filter its per-step execution history — and it round-trips through the facade.
        expect(exec.failure?.stepIndex).toBe(exec.steps.indexOf(deployStep))
        // The failed EnvironmentRecord round-tripped through the facade's registry repo and
        // projects onto the step — the cross-runtime persistence + column-mapping assertion.
        expect(deployStep.environment?.status).toBe('failed')
        expect(deployStep.environment?.lastError).toContain('ECONNREFUSED')
      })

      it('drives the async container-backed deploy lifecycle to an identical environment on every facade', async () => {
        // Per-service provision types (Phase 2, slice 10): a `deployer` step whose provider needs
        // RENDERING (kustomize/helm) stands the env up in a deploy CONTAINER — dispatch a `deploy`
        // job, park, poll, finalize — instead of the synchronous in-Worker REST path.
        //
        // SCOPE: this injects a FAKE `deployJobClient` + `resolveDeployCloneTarget` as core
        // overrides, which each facade harness spreads LAST — so they win over the real wiring
        // (`selectDeployDeps` on the Worker, the pool-backed default on Node, `NativeCliDeployTransport`
        // locally). It therefore does NOT exercise that per-facade transport selection (a
        // wrong-namespace / wrong-image-tag wiring would not be caught here — that is out of this
        // runtime-neutral suite's scope; only local's selection has a dedicated unit test today). What
        // this asserts cross-runtime is two runtime-NEUTRAL things that must hold
        // identically on D1 and Postgres: (1) the engine drives the async lifecycle and forwards the
        // provider's `deploy` kind + `image: 'deploy'` option through whatever client is wired, and
        // (2) the finalized `RunnerJobView` maps into an env record that round-trips through each
        // facade's REAL registry repo (D1 ⇄ Drizzle) to the SAME `ProvisionedEnvironment`. A facade
        // that mapped the finalized record's columns differently diverges here instead of shipping
        // silently.
        const dispatched: { ref: RunnerJobRef; kind: string; image?: string }[] = []
        const doneView: RunnerJobView = {
          state: 'done',
          result: {
            // The harness's structured DeployOutcome on the `custom` channel (namespace/url/status).
            custom: {
              namespace: 'preview-pr-1',
              url: 'https://pr-1.preview.test',
              status: 'ready',
            },
          },
        }
        const deployJobClient = {
          dispatch: async (
            _workspaceId: string | undefined,
            ref: RunnerJobRef,
            _spec: Record<string, unknown>,
            kind: string,
            options?: { image?: string },
          ) => {
            dispatched.push({ ref, kind, ...(options?.image ? { image: options.image } : {}) })
          },
          poll: async () => doneView,
          release: async () => {},
        }
        const resolveDeployCloneTarget = async (): Promise<DeployCloneTarget> => ({
          cloneUrl: 'https://github.com/acme/app.git',
          ref: 'main',
        })
        // A provider that renders asynchronously: `buildProvisionJob` returns a deploy job (so the
        // async path runs), `finalizeProvision` maps the harness DeployOutcome → environment. Its
        // synchronous `provision` must never be reached on this path.
        const provider = {
          provision: async () => {
            throw new Error('the async deploy path must not fall back to synchronous provision')
          },
          status: async () => ({ externalId: 'preview-pr-1', status: 'ready', url: null }) as never,
          teardown: async () => ({ status: 'torn_down' }) as never,
          asyncProvision: {
            buildProvisionJob: (req: { deploy?: { ref: RunnerJobRef } }) => ({
              ref: req.deploy!.ref,
              spec: { jobId: req.deploy!.ref.jobId, renderer: 'kustomize' },
              kind: 'deploy' as const,
              options: { image: 'deploy' as const },
            }),
            finalizeProvision: (view: RunnerJobView) => {
              const outcome = view.result?.custom as {
                namespace: string
                url: string | null
                status: string
              }
              return {
                externalId: outcome.namespace,
                url: outcome.url,
                status: outcome.status as never,
                expiresAt: null,
                access: null,
                fields: {},
              }
            },
          },
        }
        const app = harness.makeApp(undefined, {
          environmentProvider: provider as unknown as EnvironmentProvider,
          deployJobClient: deployJobClient as never,
          resolveDeployCloneTarget,
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A registered connection gives the provider its manifest (the legacy single-connection
        // path the deployer resolves through when the service declares no per-type provisioning).
        const manifest = {
          providerId: 'acme-k8s',
          label: 'Acme Kubernetes',
          baseUrl: 'https://k8s.test/api',
          auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
          provision: { method: 'POST', pathTemplate: '/environments' },
          response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        }
        const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
          config: { kind: 'manifest', manifest },
          secrets: { API_TOKEN: 'super-secret-env-token' },
        })
        expect(registered.status).toBe(201)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Deploy only',
          agentKinds: ['deployer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        // The engine dispatched a `deploy`-kind job (carrying the `image: 'deploy'` variant) through
        // the wired client — the slice-10 transport-acceptance assertion.
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]!.kind).toBe('deploy')
        expect(dispatched[0]!.image).toBe('deploy')
        // The stubbed terminal view finalized into the env record, which round-tripped through the
        // facade's registry repo (D1 ⇄ Drizzle) and projects onto the step — identical on both runtimes.
        const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
        expect(deployStep.state).toBe('done')
        expect(deployStep.environment?.status).toBe('ready')
        expect(deployStep.environment?.url).toBe('https://pr-1.preview.test')
      })

      it('registers, lists, rotates, and removes a per-type infra handler on every facade', async () => {
        // Per-service provision types (slice 4): the per-type handler surface (the workspace
        // "how"). A workspace registers one handler per provision type; the batched bundle
        // lists them (sans secret VALUES) alongside the custom-manifest-type catalog. This is
        // the reshaped-connection store read/written through the controller — a repo that
        // mangled the handler row, the engine, or the secret-key projection diverges here.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        // A fresh workspace has no handlers and (no registry wired) an empty custom catalog.
        const empty = await call<{ handlers: unknown[]; customTypes: unknown[] }>(
          'GET',
          `${base}/handlers`,
        )
        expect(empty.status).toBe(200)
        expect(empty.body.handlers).toEqual([])
        expect(empty.body.customTypes).toEqual([])

        // Register a kubernetes handler (engine `remote-kubernetes`, backend `kubernetes`).
        // The service-owned manifest source is NOT here — it's merged from the service at
        // provision time — so the handler carries only the apiserver/url engine config.
        const registered = await call<{
          provisionType: string
          engine: string
          providerId: string
          secretKeys: string[]
        }>('POST', `${base}/handlers`, {
          provisionType: 'kubernetes',
          config: {
            engine: 'remote-kubernetes',
            kubernetes: {
              label: 'Prod cluster',
              apiServerUrl: 'https://cluster.example:6443',
              url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
            },
          },
          secrets: { apiToken: 'sa-token-value' },
        })
        expect(registered.status).toBe(201)
        expect(registered.body.provisionType).toBe('kubernetes')
        expect(registered.body.engine).toBe('remote-kubernetes')
        expect(registered.body.secretKeys).toEqual(['apiToken'])
        expect(JSON.stringify(registered.body)).not.toContain('sa-token-value')

        // It lists back as metadata only (no secret values).
        const listed = await call<{
          handlers: { provisionType: string; engine: string }[]
        }>('GET', `${base}/handlers`)
        expect(listed.body.handlers.map((h) => h.provisionType)).toEqual(['kubernetes'])
        expect(listed.body.handlers[0]!.engine).toBe('remote-kubernetes')
        expect(JSON.stringify(listed.body)).not.toContain('sa-token-value')

        // Rotate the secret bundle for the type without re-sending the config.
        const rotated = await call<{ secretKeys: string[] }>(
          'PATCH',
          `${base}/handlers/kubernetes/secrets`,
          { secrets: { apiToken: 'rotated-token' } },
        )
        expect(rotated.status).toBe(200)
        expect(rotated.body.secretKeys).toEqual(['apiToken'])

        // Unregister tombstones it; the bundle goes empty again.
        const del = await call('DELETE', `${base}/handlers/kubernetes`)
        expect(del.status).toBe(204)
        const after = await call<{ handlers: unknown[] }>('GET', `${base}/handlers`)
        expect(after.body.handlers).toEqual([])
      })

      it('CRUDs the workspace custom-manifest-type catalog on every facade', async () => {
        // The UI-editable half of the `custom` provision-type catalog. A workspace defines a
        // manifest type a service can pin (and a `remote-custom` handler can accept); it reads
        // back in the handlers bundle marked `source: 'workspace'`. The custom_manifest_types
        // table round-trips through each facade's store (D1 ⇄ Drizzle).
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        const created = await call<{ manifestId: string; label: string; source: string }>(
          'PUT',
          `${base}/custom-types/terraform`,
          { label: 'Terraform', description: 'HCL plan + apply' },
        )
        expect(created.status).toBe(200)
        expect(created.body.manifestId).toBe('terraform')
        expect(created.body.source).toBe('workspace')

        const bundle = await call<{ customTypes: { manifestId: string; label: string }[] }>(
          'GET',
          `${base}/handlers`,
        )
        expect(bundle.body.customTypes.map((t) => t.manifestId)).toEqual(['terraform'])
        expect(bundle.body.customTypes[0]!.label).toBe('Terraform')

        const del = await call('DELETE', `${base}/custom-types/terraform`)
        expect(del.status).toBe(204)
        const after = await call<{ customTypes: unknown[] }>('GET', `${base}/handlers`)
        expect(after.body.customTypes).toEqual([])
      })

      it('runs an `infraless` deployer step as a no-op (no environment) on every facade', async () => {
        // Per-service provision types (slice 3): the deployer resolves the SERVICE frame's
        // declared provisioning. A service explicitly declaring `infraless` stands nothing up
        // — the deployer records a no-op step output and the run completes WITHOUT calling the
        // provider or persisting an environment. This is the runtime-neutral engine branch; a
        // facade that wired the deployer differently (or still hit the legacy connection)
        // diverges here. No connection is registered, proving the provider is never reached.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Declare the service frame `infraless` (the run targets a task nested under it).
        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          provisioning: { type: 'infraless' },
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Deploy only',
          agentKinds: ['deployer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        // The run completed cleanly and the deployer step is done with the no-op output.
        expect(exec.status).toBe('done')
        const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
        expect(deployStep.state).toBe('done')
        expect(deployStep.output).toContain('infraless')
        expect(deployStep.environment ?? null).toBeNull()

        // Nothing was provisioned — the registry is empty.
        const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
        expect(envs.body).toHaveLength(0)
      })

      it('runs a `library` frame`s deploy+test pipeline suite-focused: deployer no-ops, tester runs, no env — even with a compose path declared', async () => {
        // Library-frame support: the frame CAPABILITY PROFILE (`frameProfile`), not the provisioning
        // type, decides behaviour. A `library` frame is never deployed and needs no ephemeral env —
        // its tester runs the suite in-container. So a deploy+test pipeline on a task under a library
        // frame must (a) record the deployer step as a library no-op (never reaching the provider),
        // and (b) run the tester to completion with NO provisioned environment — even when the frame
        // declares a `docker-compose` path (repo-local TEST infra, not a deployable env). A facade
        // that consulted the provision type instead of the frame type would try to deploy here.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A real `library` frame (POST /blocks accepts a block type), with a task nested under it.
        const frame = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'library',
          position: { x: 1200, y: 1200 },
        })
        expect(frame.status).toBe(201)
        expect(frame.body.type).toBe('library')
        const libFrameId = frame.body.id

        // Declare a compose path — on a library this is repo-local test infra, NOT an environment.
        // The deployer must STILL skip it (proving profile-over-provisioning).
        await app.call('PATCH', `/workspaces/${wsId}/blocks/${libFrameId}`, {
          provisioning: { type: 'docker-compose', composePath: 'packages/db/docker-compose.yml' },
        })

        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/${libFrameId}/tasks`,
          {
            title: 'Add a public helper',
            description: 'A new exported utility with tests.',
          },
        )
        expect(task.status).toBe(201)
        const taskId = task.body.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Deploy + test',
          agentKinds: ['deployer', 'tester-api'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${taskId}/executions`,
          { pipelineId: pipeline.body.id },
        )
        // The run STARTS (the library short-circuits in the tester-infra / deployer start gates keep
        // a compose-declaring library from being refused for a "missing handler").
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === taskId)!
        expect(exec.status).toBe('done')

        // The deployer is a library no-op (records WHY it skipped; provider never reached, no env).
        const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
        expect(deployStep.state).toBe('done')
        expect(deployStep.output).toContain('Library frame')
        expect(deployStep.environment ?? null).toBeNull()

        // The tester still ran (suite posture) — a library`s missing env is never a dead-end.
        const testStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testStep.state).toBe('done')

        // Nothing was provisioned.
        const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
        expect(envs.body).toHaveLength(0)
      })

      it('describes the provider config + missingRequired identically on every facade', async () => {
        // `GET /provider` self-describes the connect form (configFields) and reports which
        // required-without-default fields the workspace still owes (`missingRequired`, the
        // unconfigured-provider banner signal). The describe pipeline runs against the real
        // store + cipher — describeConfig over the saved manifest, plus the decrypted secret
        // bundle / manifest providerConfig as the "already supplied" set — so a repo that
        // dropped the manifest or failed to decrypt the bundle would diverge here.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        // No connection yet: the generic manifest provider has no manifest to read, so it
        // declares no fields and owes nothing.
        const before = await call<{ missingRequired: string[]; configFields: unknown[] }>(
          'GET',
          `${base}/provider`,
        )
        expect(before.status).toBe(200)
        expect(before.body.missingRequired).toEqual([])

        // After registering a manifest whose bearer auth references API_TOKEN — and
        // supplying it — the field is described AND counts as satisfied, so nothing is
        // missing (the secret bundle round-tripped through the store + cipher).
        const manifest = {
          providerId: 'acme-envs',
          label: 'Acme Ephemeral Envs',
          baseUrl: 'https://envs.test/api',
          auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
          provision: { method: 'POST', pathTemplate: '/environments' },
          response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        }
        await call('POST', `${base}/connection`, {
          config: { kind: 'manifest', manifest },
          secrets: { API_TOKEN: 'super-secret-env-token' },
        })

        const after = await call<{
          missingRequired: string[]
          configFields: { key: string }[]
        }>('GET', `${base}/provider`)
        expect(after.body.configFields.map((f) => f.key)).toContain('API_TOKEN')
        expect(after.body.missingRequired).toEqual([])
        expect(JSON.stringify(after.body)).not.toContain('super-secret-env-token')
      })

      it('rejects an internal management-API host under the strict URL policy', async () => {
        // The default (strict) URL/host safety policy forbids private/internal hosts at
        // registration on every runtime — so a trusted-internal deployment (e.g. an
        // in-house adapter on a `.internal` host) MUST opt in via the operator allow-list
        // rather than the host slipping through. The conformance env config sets no
        // allow-list, so the strict default applies identically on D1 and Postgres.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const manifest = {
          providerId: 'internal-envs',
          label: 'Internal Envs',
          baseUrl: 'https://kargo.internal/api',
          auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
          provision: { method: 'POST', pathTemplate: '/environments' },
          response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        }
        const res = await call('POST', `/workspaces/${workspace.id}/environments/connection`, {
          config: { kind: 'manifest', manifest },
          secrets: { API_TOKEN: 't' },
        })
        // A validation failure (the SSRF/internal-host guard), not a 201.
        expect(res.status).toBeGreaterThanOrEqual(400)
      })

      it('runs a native provider repo-config validation through the wired coords resolver', async () => {
        // The repo-config lifecycle (PR #416): a native provider declares repo
        // expectations via `validateRepo`, and the facade wires `resolveRepoFilesForCoords`
        // so the on-demand `POST /connection/validate-repo` route reads the named repo
        // through a checkout-free RepoFiles and returns the provider's verdict. This must
        // behave identically on D1 and Postgres — a facade that forgot to wire the coords
        // resolver (or the controller route) fails here. The provider + resolver are fakes
        // (an in-memory path→content map), so no real GitHub connection is needed; the
        // route degrades to "no VCS connection" when the resolver is absent.
        const seed = (files: Record<string, string>) => {
          const store = new Map(Object.entries(files))
          const repo = {
            getFile: async (path: string) => {
              const content = store.get(path)
              return content != null ? { content, sha: `sha:${path}` } : null
            },
            listDirectory: async () => [],
            headSha: async () => 'base-sha',
            createBranch: async () => {},
            deleteBranch: async () => {},
            commitFiles: async () => ({ sha: 'c' }),
            openPullRequest: async () => ({ number: 1 }) as never,
          }
          return { repo, baseBranch: 'main' }
        }
        // A native provider that requires a `.kargo.yml` carrying a `jobs:` line.
        const provider = {
          provision: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
          status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
          teardown: async () => ({ status: 'torn_down' }) as never,
          validateRepo: async (req: {
            readRepoFile: (p: string) => Promise<{ content: string } | null>
          }) => {
            const file = await req.readRepoFile('.kargo.yml')
            const ok = !!file && file.content.includes('jobs')
            return ok
              ? { ok: true, issues: [] }
              : {
                  ok: false,
                  issues: [
                    {
                      severity: 'error' as const,
                      message: file ? 'missing jobs' : 'missing .kargo.yml',
                      path: '.kargo.yml',
                    },
                  ],
                }
          },
        }

        // A repo WITHOUT a valid config → the route surfaces the provider's error issues.
        const invalid = harness.makeApp(undefined, {
          environmentProvider: provider as unknown as EnvironmentProvider,
          resolveRepoFilesForCoords: async () =>
            seed({ '.kargo.yml': 'name: x\n' }) as unknown as RunRepoContext,
        })
        const wsBad = (await invalid.createWorkspace()).workspace
        // The descriptor advertises the capability identically on every runtime.
        const desc = await invalid.call<{ supportsRepoValidation?: boolean }>(
          'GET',
          `/workspaces/${wsBad.id}/environments/provider`,
        )
        expect(desc.body.supportsRepoValidation).toBe(true)
        const bad = await invalid.call<RepoValidationResult>(
          'POST',
          `/workspaces/${wsBad.id}/environments/connection/validate-repo`,
          { owner: 'acme', repo: 'widgets' },
        )
        expect(bad.status).toBe(200)
        expect(bad.body.ok).toBe(false)
        expect(bad.body.issues[0]?.path).toBe('.kargo.yml')

        // A repo WITH a valid config → ok with no issues (no connection registered first:
        // the route must not 409 when nothing is registered — the on-demand contract).
        const valid = harness.makeApp(undefined, {
          environmentProvider: provider as unknown as EnvironmentProvider,
          resolveRepoFilesForCoords: async () =>
            seed({ '.kargo.yml': 'name: x\njobs: [build]\n' }) as unknown as RunRepoContext,
        })
        const wsGood = (await valid.createWorkspace()).workspace
        const good = await valid.call<RepoValidationResult>(
          'POST',
          `/workspaces/${wsGood.id}/environments/connection/validate-repo`,
          { owner: 'acme', repo: 'widgets' },
        )
        expect(good.status).toBe(200)
        expect(good.body).toEqual({ ok: true, issues: [] })
      })

      it('honours deployment-level detection conventions for service-provisioning detection', async () => {
        // The detection LOGIC is a shared pure function (unit-tested in @cat-factory/integrations);
        // the runtime-specific part is each facade threading `config.environments.detectionConventions`
        // into the core deps. This asserts that wiring on EVERY runtime: a repo whose only compose
        // file uses a NON-canonical name (`stack.yml`) is invisible to a default detector, but is
        // detected once the deployment adds that name via conventions. A facade that forgot the
        // config→deps threading (or wired only one runtime) fails here instead of silently reverting
        // to built-ins. The reader is a fake (an in-memory path→content map) so no GitHub is needed —
        // it flows through the SAME `resolveRepoFilesForCoords` seam the validate-repo route uses.
        const seed = (files: Record<string, string>): RunRepoContext => {
          const paths = Object.keys(files)
          const repo = {
            getFile: async (path: string) =>
              path in files ? { content: files[path]!, sha: `sha:${path}` } : null,
            // A minimal one-level directory listing over the in-memory paths, enough for the
            // compose-file scan (`findCompose` lists the root + common compose dirs).
            listDirectory: async (dir: string) => {
              const prefix = dir ? `${dir}/` : ''
              const seen = new Set<string>()
              const entries: { name: string; type: string; path: string }[] = []
              for (const p of paths) {
                if (prefix && !p.startsWith(prefix)) continue
                const rest = p.slice(prefix.length)
                if (!rest) continue
                const seg = rest.split('/')[0]!
                if (seen.has(seg)) continue
                seen.add(seg)
                entries.push({
                  name: seg,
                  type: rest.includes('/') ? 'dir' : 'file',
                  path: prefix + seg,
                })
              }
              return entries
            },
            headSha: async () => 'base-sha',
            createBranch: async () => {},
            deleteBranch: async () => {},
            commitFiles: async () => ({ sha: 'c' }),
            openPullRequest: async () => ({ number: 1 }) as never,
          }
          return { repo, baseBranch: 'main' } as unknown as RunRepoContext
        }
        const files = { 'stack.yml': 'services:\n  app:\n    image: nginx\n' }
        type DetectResult = { provisioning: { type: string; composePath?: string } }

        // Default (no conventions): the non-canonical name is not a compose file ⇒ nothing detected.
        const plain = harness.makeApp(undefined, {
          resolveRepoFilesForCoords: async () => seed(files),
        })
        const wsPlain = (await plain.createWorkspace()).workspace
        const off = await plain.call<DetectResult>(
          'POST',
          `/workspaces/${wsPlain.id}/environments/detect-provisioning`,
          { owner: 'acme', repo: 'widgets', prefer: 'docker-compose' },
        )
        expect(off.status).toBe(200)
        expect(off.body.provisioning.type).toBe('infraless')

        // With the deployment convention adding `stack.yml`: detected as docker-compose here too.
        const conv = harness.makeApp(undefined, {
          resolveRepoFilesForCoords: async () => seed(files),
          detectionConventions: { composeFiles: ['stack.yml'] },
        })
        const wsConv = (await conv.createWorkspace()).workspace
        const on = await conv.call<DetectResult>(
          'POST',
          `/workspaces/${wsConv.id}/environments/detect-provisioning`,
          { owner: 'acme', repo: 'widgets', prefer: 'docker-compose' },
        )
        expect(on.status).toBe(200)
        expect(on.body.provisioning.type).toBe('docker-compose')
        expect(on.body.provisioning.composePath).toBe('stack.yml')
      })

      it('drives an env-config-repair run to success and records the post-repair validation', async () => {
        // The durable, asynchronous config-repair fallback (PR #424 follow-up): when
        // mechanical bootstrap can't synthesise a valid provider config and the caller opts
        // in, the service dispatches a coding agent as its OWN `env-config-repair` agent_runs
        // run and returns immediately (ok pending) — then re-validates on completion. This
        // must behave identically on D1 and Postgres: a facade that wired the durable repair
        // into only one runtime (or maps the kind-scoped row differently) fails here.
        //
        // A MUTABLE in-memory repo lets us simulate the agent's push: the config file is
        // flipped from invalid to valid between dispatch and drive, so the service's injected
        // re-validation (→ provider.validateRepo) records ok:true. The repairer itself is the
        // deterministic FakeEnvConfigRepairer the harness injects (no GitHub / container).
        const store = new Map<string, string>([['.kargo.yml', 'name: x\n']]) // invalid: no `jobs`
        const repo = {
          getFile: async (path: string) => {
            const content = store.get(path)
            return content != null ? { content, sha: `sha:${path}` } : null
          },
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async () => ({ sha: 'c' }),
          openPullRequest: async () => ({ number: 1 }) as never,
        }
        const provider = {
          provision: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
          status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
          teardown: async () => ({ status: 'torn_down' }) as never,
          validateRepo: async (req: {
            readRepoFile: (p: string) => Promise<{ content: string } | null>
          }) => {
            const file = await req.readRepoFile('.kargo.yml')
            const ok = !!file && file.content.includes('jobs')
            return ok
              ? { ok: true, issues: [] }
              : {
                  ok: false,
                  issues: [
                    { severity: 'error' as const, message: 'missing jobs', path: '.kargo.yml' },
                  ],
                }
          },
          // Mechanical bootstrap can't synthesise a config → ask for the agent fallback.
          bootstrapProviderConfiguration: async () => ({
            files: [],
            needsAgent: true,
            issues: [{ severity: 'error' as const, message: 'cannot synthesize config' }],
          }),
          // Declares agent-repair support (the fallback's gate; the fake repairer performs it).
          describeRepairAgent: () => ({ prompt: 'Fix .kargo.yml: add a jobs list.' }),
        }

        const app = harness.makeApp(undefined, {
          environmentProvider: provider as unknown as EnvironmentProvider,
          resolveRepoFilesForCoords: async () =>
            ({ repo, baseBranch: 'main' }) as unknown as RunRepoContext,
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Mechanical bootstrap bails (needsAgent) → the durable repair run is dispatched and
        // the call returns immediately with the run id and ok pending (false).
        const started = await app.call<{ ok: boolean; usedAgent?: boolean; repairJobId?: string }>(
          'POST',
          `/workspaces/${wsId}/environments/connection/bootstrap-repo`,
          { owner: 'acme', repo: 'widgets', inputs: {}, allowAgentFallback: true },
        )
        expect(started.status).toBe(200)
        expect(started.body.usedAgent).toBe(true)
        expect(started.body.ok).toBe(false)
        const jobId = started.body.repairJobId
        expect(jobId).toBeTruthy()

        // Persisted as a running env-config-repair agent_runs row, surfaced on the snapshot
        // (no board block — it's an infra-window run).
        const before = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const running = before.body.envConfigRepairJobs?.find((j) => j.id === jobId)
        expect(running?.status).toBe('running')

        // Simulate the agent pushing its fix, then drive the durable poll loop (production: a
        // pg-boss queue / an EnvConfigRepairWorkflow). The fake reports `done` on the first
        // poll, which triggers the service's re-validation against the now-valid repo.
        store.set('.kargo.yml', 'name: x\njobs: [build]\n')
        const polls = await app.driveEnvConfigRepair(wsId, jobId!)
        expect(polls).toBeGreaterThanOrEqual(1)

        // Finalised as succeeded with the post-repair validation recorded ok:true — on both
        // D1 and Postgres.
        const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const done = after.body.envConfigRepairJobs?.find((j) => j.id === jobId)
        expect(done?.status).toBe('succeeded')
        expect(done?.ok).toBe(true)
        expect(done?.issues).toEqual([])
      })
    })

    describe('board', () => {
      it('adds a top-level frame', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
          type: 'service',
          position: { x: 10, y: 20 },
        })
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('frame')
      })

      it('deletes a top-level frame and reclaims its backing service in one batched read', async () => {
        // Deleting a top-level frame reclaims the account-owned service it backs — resolved for
        // every doomed frame in ONE batched query (`listByFrameBlocks`), then its row + mounts
        // are deleted. Exercised on every runtime so the batched frame→service lookup can't map
        // differently between stores. GitHub is off in conformance (the only production path that
        // mints a service), so seed a real service linked to the frame directly, then assert the
        // delete actually reclaims it — not just that the block vanished.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const frame = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
          type: 'service',
          position: { x: 0, y: 0 },
        })
        expect(frame.body.level).toBe('frame')
        const serviceId = `svc-${frame.body.id}`
        await app.seedService({
          id: serviceId,
          accountId: null,
          frameBlockId: frame.body.id,
          installationId: null,
          repoGithubId: null,
          createdAt: 1,
        })
        // The service resolves by its frame before deletion.
        expect(await app.getService(serviceId)).not.toBeNull()

        const removed = await app.call(
          'DELETE',
          `/workspaces/${workspace.id}/blocks/${frame.body.id}`,
        )
        expect(removed.status).toBe(204)
        const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        expect(snap.body.blocks.some((b) => b.id === frame.body.id)).toBe(false)
        // The batched frame→service resolve found the backing service and reclaimed it.
        expect(await app.getService(serviceId)).toBeNull()
      })

      it('adds a user-authored task pinning a pipeline', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/tasks`,
          { title: 'Add SSO login', description: 'Support SAML and OIDC.', pipelineId: 'pl_quick' },
        )
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('task')
        expect(res.body.parentId).toBe('blk_auth')
        expect(res.body.title).toBe('Add SSO login')
        expect(res.body.pipelineId).toBe('pl_quick')
      })

      it('rejects a task without a title', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/blk_auth/tasks`, {})
        expect(res.status).toBe(400)
      })

      it('adds a module to a service but rejects one on a task', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ok = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/modules`,
          { name: 'Tokens' },
        )
        expect(ok.status).toBe(201)
        expect(ok.body.level).toBe('module')

        const bad = await app.call(
          'POST',
          `/workspaces/${workspace.id}/blocks/task_login/modules`,
          {
            name: 'Nope',
          },
        )
        expect(bad.status).toBe(422)
      })

      it('updates a block', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const patched = await app.call<Block>(
          'PATCH',
          `/workspaces/${workspace.id}/blocks/blk_auth`,
          { description: 'Updated description' },
        )
        expect(patched.status).toBe(200)
        expect(patched.body.description).toBe('Updated description')
      })

      it('deletes a block idempotently — gone or unknown is a 204, never a 404', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        // A block not existing must never block deletion: a repeated delete, and a delete of an
        // id that never existed, both clean up best-effort and return 204 rather than 404.
        // `blk_frontend` is a childless service (deletable); a service WITH unfinished tasks is
        // archived instead of deleted (asserted separately).
        const first = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_frontend`)
        expect(first.status).toBe(204)
        const again = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_frontend`)
        expect(again.status).toBe(204)
        const unknown = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_nope`)
        expect(unknown.status).toBe(204)
      })

      it('refuses to delete a service with unfinished tasks and archives/restores it', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        // blk_auth carries planned (unfinished) tasks, so a destructive delete is rejected.
        const del = await app.call('DELETE', `/workspaces/${ws}/blocks/blk_auth`)
        expect(del.status).toBe(422)

        // Archiving hides the service + its whole subtree from the board and surfaces it for restore
        // — the `archived` column must persist + read back identically on every store.
        const archived = await app.call<{ archived?: boolean }>(
          'POST',
          `/workspaces/${ws}/blocks/blk_auth/archive`,
        )
        expect(archived.status).toBe(200)
        expect(archived.body.archived).toBe(true)

        let snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)).body
        expect(snap.blocks.find((b) => b.id === 'blk_auth')).toBeUndefined()
        expect(snap.blocks.find((b) => b.id === 'task_login')).toBeUndefined()
        expect(snap.archivedServices?.find((b) => b.id === 'blk_auth')).toBeTruthy()

        const restored = await app.call<{ archived?: boolean }>(
          'POST',
          `/workspaces/${ws}/blocks/blk_auth/restore`,
        )
        expect(restored.status).toBe(200)
        expect(restored.body.archived).toBeFalsy()

        snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)).body
        expect(snap.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
        expect(snap.blocks.find((b) => b.id === 'task_login')).toBeTruthy()
        expect(snap.archivedServices?.find((b) => b.id === 'blk_auth')).toBeFalsy()
      })
    })
  })
}

import {
  type EnvironmentBackendProvider,
  type RunnerBackendProvider,
  createBackendRegistries,
} from '@cat-factory/integrations'
import type { RiskPolicy } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

export function defineProvisioningConformance(harness: ConformanceHarness): void {
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
      expect(afterReseed.body.filter((p) => p.isDefault).map((p) => p.id)).toEqual([custom.body.id])

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
}

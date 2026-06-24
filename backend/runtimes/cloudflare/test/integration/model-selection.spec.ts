import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  Block,
  ProviderCapabilities,
} from '@cat-factory/kernel'
import {
  ALL_SUBSCRIPTION_VENDORS,
  effectiveCatalog,
  MODEL_CATALOG,
  resolveModelRef,
} from '@cat-factory/kernel'
import type { ModelOption } from '@cat-factory/contracts'
import { modelCatalogSchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

// Capability fakes for the resolver. Cloudflare is enabled and every subscription
// vendor connected throughout (the deployment-level baseline); only the set of
// configured DIRECT provider keys varies, which is what drives the direct switch.
const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  directProviders: new Set<string>(),
  subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
  cloudflareEnabled: true,
  ...over,
})
const noKeys = caps()
const allKeys = caps({
  directProviders: new Set(MODEL_CATALOG.flatMap((m) => (m.direct ? [m.direct.ref.provider] : []))),
})

// Derive expectations from the catalog itself rather than hardcoding its members, so
// these stay green as models are added/removed/renamed — they assert the resolution
// *behaviour*, not a snapshot of the model list.
const directModels = MODEL_CATALOG.filter((m) => m.direct)
// Models with an always-available base (a Cloudflare and/or direct variant); they
// resolve to that base flavour. Subscription-only models (no base — Claude
// Opus/Sonnet, GPT via Codex) have ONLY a subscription variant, so they resolve to
// it (flavor `subscription`, flat-rate quota). The base resolver never applies the
// "subscriptions always win" override — that is a per-workspace, token-aware step in
// the executor — so a dual-mode base model (GLM/Kimi) still resolves to its base here.
const cloudflareOnlyModels = MODEL_CATALOG.filter((m) => m.cloudflare && !m.direct)
const subscriptionOnlyModels = MODEL_CATALOG.filter((m) => !m.cloudflare && !m.direct)
// Direct-ONLY models (LiteLLM): a direct variant with no Cloudflare or subscription base.
// With no key they have no base to fall back to, so the resolver returns their direct ref
// as a best-effort (selectability is reported separately).
const directOnlyModels = MODEL_CATALOG.filter((m) => m.direct && !m.cloudflare && !m.subscription)
// Gateway-ONLY models (e.g. Gemini via OpenRouter): an `openrouter` variant with no
// Cloudflare/direct/subscription base. With no OpenRouter key they likewise have no base, so
// the resolver returns the gateway ref as a best-effort.
const openRouterOnlyModels = MODEL_CATALOG.filter(
  (m) => m.openrouter && !m.cloudflare && !m.direct && !m.subscription,
)

/** The ref the base resolver lands on with no direct/gateway key: the Cloudflare base, else a
 *  subscription model's subscription ref (its vendor is connected in `noKeys`), else the
 *  best-effort gateway then direct ref — matching `effectiveVariant`'s precedence. */
const baseRef = (m: (typeof MODEL_CATALOG)[number]) =>
  m.cloudflare ?? m.subscription?.ref ?? m.openrouter?.ref ?? m.direct?.ref

describe('per-block model selection', () => {
  describe('catalog resolution', () => {
    it('falls back to the base flavour when no direct key is configured', () => {
      // A model with a base resolves to its always-available Cloudflare variant; a
      // subscription-only model (no base) resolves to its subscription ref.
      for (const model of MODEL_CATALOG) {
        expect(resolveModelRef(model.id, noKeys)).toEqual(baseRef(model))
      }
    })

    it('uses the direct flavour when the provider key is configured', () => {
      // A model with a direct variant switches to it; a base-only model stays on
      // Cloudflare; a subscription-only model has no key-gated flavour and stays on
      // its subscription ref regardless of keys.
      expect(directModels.length).toBeGreaterThan(0)
      for (const model of MODEL_CATALOG) {
        expect(resolveModelRef(model.id, allKeys)).toEqual(model.direct?.ref ?? baseRef(model))
      }
    })

    it('honours each key independently', () => {
      // With only one provider's key present, only that model goes direct; every other
      // model — including other direct-capable ones — stays on Cloudflare.
      const target = directModels[0]
      expect(target).toBeDefined()
      const onlyTarget = caps({ directProviders: new Set([target!.direct!.ref.provider]) })

      expect(resolveModelRef(target!.id, onlyTarget)).toEqual(target!.direct!.ref)

      const otherDirect = directModels.find(
        (m) => m.direct!.ref.provider !== target!.direct!.ref.provider,
      )
      if (otherDirect) {
        expect(resolveModelRef(otherDirect.id, onlyTarget)?.provider).toBe('workers-ai')
      }
    })

    it('reports the active flavour in the effective catalog', () => {
      // The effective catalog is the catalog projected onto its in-use flavours: one
      // option per model, same ids, same order.
      const cloud = effectiveCatalog(noKeys)
      expect(cloud.map((m) => m.id)).toEqual(MODEL_CATALOG.map((m) => m.id))
      for (const model of MODEL_CATALOG) {
        const option = cloud.find((o) => o.id === model.id)!
        if (model.cloudflare) {
          // A Cloudflare-having model projects to its Cloudflare flavour when no key is set.
          expect(option.flavor).toBe('cloudflare')
          expect(option.providerLabel).toBe('Cloudflare')
        } else if (model.subscription) {
          // A subscription model (its vendor is connected in `noKeys`) projects to its
          // (flat-rate quota) subscription flavour — it wins over a best-effort gateway route.
          expect(option.flavor).toBe('subscription')
          expect(option.quotaBased).toBe(true)
        } else if (model.direct) {
          // Direct-only (LiteLLM): no base, so it projects to its best-effort direct flavour
          // but is NOT selectable until its provider key is configured.
          expect(option.flavor).toBe('direct')
          expect(option.providerLabel).toBe(model.direct.providerLabel)
          expect(option.available).toBe(false)
        } else {
          // Gateway-only (Gemini via OpenRouter): best-effort gateway flavour, NOT selectable
          // until the OpenRouter key is configured.
          expect(option.flavor).toBe('openrouter')
          expect(option.providerLabel).toBe(model.openrouter!.providerLabel)
          expect(option.available).toBe(false)
        }
      }

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
        } else if (model.cloudflare) {
          // No direct variant → always Cloudflare, even with every key configured.
          expect(option.flavor).toBe('cloudflare')
        } else if (model.subscription) {
          // Subscription model stays on its subscription flavour (allKeys carries no
          // OpenRouter key, so a gateway route doesn't apply).
          expect(option.flavor).toBe('subscription')
        } else {
          // Gateway-only (Gemini via OpenRouter): no native key in allKeys, so best-effort gateway.
          expect(option.flavor).toBe('openrouter')
        }
      }
      // The flavour branches above are only meaningful if the catalog exercises each.
      expect(directModels.length).toBeGreaterThan(0)
      expect(cloudflareOnlyModels.length).toBeGreaterThan(0)
      expect(subscriptionOnlyModels.length).toBeGreaterThan(0)
      expect(directOnlyModels.length).toBeGreaterThan(0)
      expect(openRouterOnlyModels.length).toBeGreaterThan(0)
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
      // keys, so it matches the keyless projection id-for-id and flavour-for-flavour
      // (base models → `cloudflare`, subscription-only → `subscription`).
      const keyless = effectiveCatalog(noKeys)
      expect(res.body.map((m) => m.id)).toEqual(keyless.map((m) => m.id))
      expect(res.body.map((m) => m.flavor)).toEqual(keyless.map((m) => m.flavor))
      expect(res.body.length).toBeGreaterThan(0)
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

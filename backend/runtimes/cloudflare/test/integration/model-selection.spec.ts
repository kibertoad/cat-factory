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
const subscriptionOnlyModels = MODEL_CATALOG.filter(
  (m) => m.subscription && !m.cloudflare && !m.direct,
)
// Direct-ONLY models (the operator-hosted gateways): a direct variant with no Cloudflare or
// subscription base.
// With no key they have no base to fall back to, so the resolver returns their direct ref
// as a best-effort (selectability is reported separately).
const directOnlyModels = MODEL_CATALOG.filter(
  (m) => m.direct && !m.cloudflare && !m.subscription && !m.bedrock,
)
// Gateway-ONLY models (e.g. Gemini via OpenRouter): an `openrouter` variant with no
// Cloudflare/direct/Bedrock/subscription base. With no OpenRouter key they likewise have no
// base, so the resolver returns the gateway ref as a best-effort.
const openRouterOnlyModels = MODEL_CATALOG.filter(
  (m) => m.openrouter && !m.cloudflare && !m.direct && !m.subscription && !m.bedrock,
)
// Bedrock-ONLY models (Claude Opus 4.8): reachable only in an AWS account whose allow-list
// carries them. `caps` above sets no `bedrockModels`, so they are never usable here and always
// take the best-effort branch, which must still yield a ref, or the resolver would throw for
// every deployment that hasn't configured Bedrock.
const bedrockOnlyModels = MODEL_CATALOG.filter(
  (m) => m.bedrock && !m.cloudflare && !m.direct && !m.openrouter && !m.subscription,
)

/**
 * The concrete ref a bedrock flavour builds with NO allow-list: the catalog base id itself.
 *
 * This mirrors the resolver's own `bedrock` build arm, so every per-flavour fact the variant can
 * declare has to be carried here too, each under the same conditional spread. Both of them are
 * conditional rather than defaulted for the same reason: ABSENT is a real answer for both
 * (an unknown Bedrock window, an undeclared modality) and a spread `undefined` is not the same
 * object as an omitted key to `toEqual`.
 */
const bedrockRef = (m: (typeof MODEL_CATALOG)[number]) =>
  m.bedrock
    ? {
        provider: 'bedrock',
        model: m.bedrock.baseModelId,
        ...(m.bedrock.contextTokens ? { contextTokens: m.bedrock.contextTokens } : {}),
        ...(m.bedrock.acceptsImages === undefined
          ? {}
          : { acceptsImages: m.bedrock.acceptsImages }),
      }
    : undefined

/** The ref the base resolver lands on with no direct/gateway key. Both of `effectiveVariant`'s
 *  walks, in order: what is USABLE under `noKeys` (the Cloudflare base, else a subscription
 *  model's subscription ref — its vendor is connected here), then, for a model with neither,
 *  its BEST-EFFORT ref, which follows the same `DEFAULT_PROVIDER_PREFERENCE` the usable walk
 *  does. `direct` must precede `bedrock` must precede `openrouter` here for that reason: a
 *  model carrying direct and gateway routes with no base (Kimi K3) resolves to its native
 *  provider, not the gateway. This helper duplicates that ordering, so it has to be corrected
 *  in step with the resolver. */
const baseRef = (m: (typeof MODEL_CATALOG)[number]) =>
  m.cloudflare ?? m.subscription?.ref ?? m.direct?.ref ?? bedrockRef(m) ?? m.openrouter?.ref

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

    it('switches a model to Bedrock when the account allow-list carries it', () => {
      const model = MODEL_CATALOG.find((m) => m.bedrock)
      expect(model).toBeDefined()
      // The catalog declares only the UNPREFIXED base; what an account calls carries a
      // geo/global inference prefix that differs per Region, so the operator's own entry is
      // what must reach the ref.
      const listed = `eu.${model!.bedrock!.baseModelId}`
      const onBedrock = caps({ bedrockModels: new Set([listed]) })
      expect(resolveModelRef(model!.id, onBedrock)).toMatchObject({
        provider: 'bedrock',
        model: listed,
      })
      // Bedrock is a per-MODEL grant: another account's list doesn't enable this one.
      const otherModelOnly = caps({ bedrockModels: new Set(['amazon.nova-something-else']) })
      expect(resolveModelRef(model!.id, otherModelOnly)?.provider).not.toBe('bedrock')
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
          // Direct-only (an operator-hosted gateway): no base, so it projects to its direct flavour
          // but is NOT selectable until its provider key is configured.
          expect(option.flavor).toBe('direct')
          expect(option.providerLabel).toBe(model.direct.providerLabel)
          expect(option.available).toBe(false)
        } else if (model.bedrock) {
          // Bedrock-only (Claude Opus 4.8): best-effort bedrock flavour at the catalog BASE id
          // (no allow-list entry to prefer), NOT selectable until this account grants the model.
          expect(option.flavor).toBe('bedrock')
          expect(option.providerLabel).toBe('AWS Bedrock')
          expect(option.model).toBe(model.bedrock.baseModelId)
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
        } else if (model.bedrock) {
          // allKeys carries no Bedrock allow-list either (it is an AWS account grant, not a
          // key in the pool), so a Bedrock-only model stays on its best-effort bedrock flavour.
          expect(option.flavor).toBe('bedrock')
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
      expect(bedrockOnlyModels.length).toBeGreaterThan(0)
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
      // `bindCloudflareAi`: the projection this compares against is built from `noKeys`, whose
      // `cloudflareEnabled: true` is the deployment baseline a real Worker has — and the app's own
      // half of that fact comes from the `[ai]` binding's PRESENCE, which the pool otherwise
      // leaves unbound so nothing can dial a model that could only reject. This test reads the
      // catalog and never runs a step, so it is the one place that wants the binding there.
      const app = makeApp(undefined, {}, { bindCloudflareAi: true })
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
        pipelineId: 'pl_simple',
      })
      await capturingApp.drive(wsId)

      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]!.block.modelId).toBe(OTHER_MODEL_ID)
    })
  })
})

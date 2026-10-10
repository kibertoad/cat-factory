import type { PublicUseCase, UseCaseInvocation } from '@cat-factory/contracts'
import { defaultInlineUseCaseRegistry } from '@cat-factory/kernel'
import type { InlineUseCaseGenerator, InlineUseCaseModelOption } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for the public INLINE USE-CASE surface (`/api/v1/use-cases`): the
// non-container half of the API a wrapper (a game content editor, a writing tool) drives.
//
// What belongs HERE rather than in the service's own unit tests is the half a unit test cannot
// see: that each facade MOUNTS these routes and threads the injected `inlineUseCaseRegistry`
// through its own container build. That seam is exactly where a registry goes missing on one
// runtime, and the symptom is silent: a deployment's whole catalog reads as empty rather than as
// broken, which is indistinguishable from a deployment that registered nothing.
//
// The model call itself rides the injected `InlineUseCaseGenerator`, the same seam the judge and
// bug-hunt assessors use, so every assertion here runs with no model wired on any runtime.
//
// See backend/docs/inline-use-cases.md.

/** A deployment's registration, narrow enough to assert the whole projection against. */
const SCENE_PROSE = {
  useCaseId: 'conf:scene-prose',
  label: 'Scene prose',
  description: 'Write a scene from a beat sheet.',
  category: 'Narrative',
  systemPrompt: 'You write game scenes.',
  models: [
    {
      id: 'magnum',
      label: 'Magnum',
      source: { kind: 'provider', ref: { provider: 'novel', model: 'magnum-v4' } },
      default: true,
    },
    {
      id: 'flash',
      label: 'Gemini Flash',
      source: { kind: 'catalog', modelId: 'gemini' },
    },
  ] satisfies InlineUseCaseModelOption[],
  parameters: [
    { key: 'beats', label: 'Beat sheet', type: 'textarea' as const, required: true },
    {
      key: 'tone',
      label: 'Tone',
      type: 'select' as const,
      options: [
        { value: 'grim', label: 'Grim' },
        { value: 'warm', label: 'Warm' },
      ],
    },
  ],
  generation: { temperature: { default: 0.9, min: 0, max: 1.5 } },
}

/**
 * A deterministic stand-in for the model call, echoing the composed prompt back.
 *
 * Echoing rather than returning a canned string is what lets the suite assert the PROMPT the
 * engine composed from the caller's parameters, which is the part a facade's own wiring could
 * silently change (a registry threaded as a different instance would compose from no descriptors
 * at all).
 */
function fakeGenerator(): InlineUseCaseGenerator {
  return {
    enabled: true,
    forScope: (scope) =>
      Promise.resolve({
        availability: (option) =>
          option.id === 'flash'
            ? ({ available: false, reason: 'container_only' } as const)
            : ({ available: true, ref: { provider: 'novel', model: 'magnum-v4' } } as const),
        // The composed prompt AND the scope the facade resolved it under, so a facade that dropped
        // a credential tier on the way through its own container build fails here rather than
        // silently narrowing which keys a generation may draw on.
        generate: (request) =>
          Promise.resolve({
            text: `[${request.temperature}|${scope.accountId ? 'account' : 'no-account'}] ${request.prompt}`,
            finishReason: 'stop' as const,
            usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
            ref: { provider: 'novel', model: 'magnum-v4' },
          }),
      }),
  }
}

export function definePublicUseCaseConformance(harness: ConformanceHarness): void {
  describe('public API: inline use cases', () => {
    const makeApp = () => {
      const inlineUseCaseRegistry = defaultInlineUseCaseRegistry()
      inlineUseCaseRegistry.register(SCENE_PROSE)
      return harness.makeApp(undefined, {
        inlineUseCaseRegistry,
        inlineUseCaseGenerator: fakeGenerator(),
      })
    }

    it('publishes the registered catalog, with each model’s availability resolved', async () => {
      const app = makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const key = await mintPublicApiKey(app, workspace.id, 'read', 'use-cases')

      const listed = await app.call<{ useCases: PublicUseCase[] }>(
        'GET',
        '/api/v1/use-cases',
        undefined,
        key,
      )
      expect(listed.status).toBe(200)
      const useCase = listed.body.useCases.find((entry) => entry.useCaseId === 'conf:scene-prose')
      expect(useCase?.label).toBe('Scene prose')
      expect(useCase?.parameters.map((parameter) => parameter.key)).toEqual(['beats', 'tone'])
      // The narrowing, as published: two models, one default, and the unservable one listed WITH
      // its cause rather than hidden, so a wrapper's picker shows what the use case offers.
      expect(useCase?.models).toEqual([
        expect.objectContaining({ id: 'magnum', default: true, available: true }),
        expect.objectContaining({
          id: 'flash',
          default: false,
          available: false,
          unavailableReason: 'container_only',
        }),
      ])
      // A partially-declared bound folds over the platform's own default rather than replacing it.
      expect(useCase?.generation.temperature).toEqual({ default: 0.9, min: 0, max: 1.5 })

      const point = await app.call<PublicUseCase>(
        'GET',
        '/api/v1/use-cases/conf:scene-prose',
        undefined,
        key,
      )
      expect(point.status).toBe(200)
      expect(point.body.useCaseId).toBe('conf:scene-prose')
    })

    it('runs one synchronously, composing the prompt from the declared parameters', async () => {
      const app = makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const key = await mintPublicApiKey(app, workspace.id, 'write', 'use-cases')

      const run = await app.call<UseCaseInvocation>(
        'POST',
        '/api/v1/use-cases/conf:scene-prose/invocations',
        { parameters: { beats: 'They meet at dusk.', tone: 'grim' }, temperature: 1.1 },
        key,
      )
      expect(run.status).toBe(200)
      // The option's caption, not its stored value: the same prose projection a reusable
      // operation's collected values reach an agent prompt through. The `account` marker beside the
      // temperature is the credential scope the facade resolved the call under: account-scoped
      // provider keys are only in the pool when the scope names the account, so a facade that
      // forwarded the workspace alone would narrow which keys a generation may draw on, and nothing
      // else here would fail.
      expect(run.body.text).toBe(`[1.1|account] Beat sheet: They meet at dusk.\nTone: Grim`)
      expect(run.body.model).toEqual({
        id: 'magnum',
        label: 'Magnum',
        provider: 'novel',
        model: 'magnum-v4',
      })
      expect(run.body.truncated).toBe(false)
      expect(run.body.usage.totalTokens).toBe(8)
    })

    it('refuses a model outside the use case’s own list rather than substituting one', async () => {
      const app = makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const key = await mintPublicApiKey(app, workspace.id, 'write', 'use-cases')

      const refused = await app.call<{ error: { code: string; details?: { reason?: string } } }>(
        'POST',
        '/api/v1/use-cases/conf:scene-prose/invocations',
        { model: 'gpt-nope', parameters: { beats: 'x' } },
        key,
      )
      expect(refused.status).toBe(422)
      expect(refused.body.error.details?.reason).toBe('use_case_model_not_allowed')

      // …and a model the deployment cannot serve inline is its own refusal, not a fallback.
      const unavailable = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        '/api/v1/use-cases/conf:scene-prose/invocations',
        { model: 'flash', parameters: { beats: 'x' } },
        key,
      )
      expect(unavailable.status).toBe(503)
      expect(unavailable.body.error.details?.reason).toBe('use_case_model_unavailable')
    })

    it('validates the parameters against the registration, and 404s an unknown use case', async () => {
      const app = makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const key = await mintPublicApiKey(app, workspace.id, 'write', 'use-cases')

      const invalid = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        '/api/v1/use-cases/conf:scene-prose/invocations',
        { parameters: { tone: 'lurid' } },
        key,
      )
      expect(invalid.status).toBe(422)
      expect(invalid.body.error.details?.reason).toBe('use_case_parameters_invalid')

      const missing = await app.call<{ error: { details?: { reason?: string } } }>(
        'GET',
        '/api/v1/use-cases/conf:nope',
        undefined,
        key,
      )
      expect(missing.status).toBe(404)
      expect(missing.body.error.details?.reason).toBe('use_case_not_found')
    })

    it('answers the catalog on a deployment that registered nothing, rather than 404ing', async () => {
      // An empty catalog and a missing surface are different facts. A wrapper reading a 404 here
      // would conclude this deployment does not support use cases at all.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const key = await mintPublicApiKey(app, workspace.id, 'read', 'use-cases')
      const listed = await app.call<{ useCases: PublicUseCase[] }>(
        'GET',
        '/api/v1/use-cases',
        undefined,
        key,
      )
      expect(listed.status).toBe(200)
      expect(listed.body.useCases).toEqual([])
    })
  })
}

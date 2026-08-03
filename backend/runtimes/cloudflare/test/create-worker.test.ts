import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultBinaryGeneratorRegistry,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
import { resetRegistrationValidationGuard } from '@cat-factory/orchestration'
import { createWorker } from '../src/index'
import type { Env } from '../src/infrastructure/env'

// The Cloudflare facade's INSTALLATION SEAM. Every app-owned registry used to be newed at module
// scope and handed to `createApp` without any of the instances being exported, so a deployment
// that re-exported the default handler — the shape `deploy/backend` uses, and the shape a
// downstream deployment naturally copies — could register nothing at all. `createWorker(options)`
// is the counterpart of the Node facade's `start({ … })` and the local facade's
// `startLocal({ … })`, which have always taken the registries as options.
//
// This drives the seam through the property that is cheapest to observe without bindings and
// hardest to fake: boot validation. It runs over WHATEVER registries the options carry, so a
// deployment's own definition being refused proves the injected instance reached the boot path —
// which is the same instance `createApp` builds every per-request container from.

const noEnv = {} as Env
const noCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as Parameters<
  NonNullable<ReturnType<typeof createWorker>['fetch']>
>[2]

afterEach(() => {
  // The once-guard is module-global; each case here boots a fresh "deployment".
  resetRegistrationValidationGuard()
})

describe('createWorker', () => {
  it('exposes the full handler, so a deployment never has to spread the default export', () => {
    const worker = createWorker()
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
    expect(typeof worker.queue).toBe('function')
  })

  it('boot-validates the INJECTED foundational-service registry', async () => {
    const foundationalServiceRegistry = defaultFoundationalServiceRegistry()
    foundationalServiceRegistry.register({
      id: 'file-storage',
      name: 'File Storage',
      summary: 'Stores blobs.',
      description: 'The org-wide blob store.',
      capabilities: ['asset-storage'],
      // Declared as OpenAPI, but unparseable — the quiet failure code registration exists to
      // catch: it would otherwise become a catalog entry listing no operations while looking
      // perfectly registered.
      contracts: [
        { contractId: 'http', format: 'openapi', title: 'HTTP API', body: 'not a document' },
      ],
    })
    const worker = createWorker({ overrides: { foundationalServiceRegistry } })
    // Wrapped in an async thunk because the refusal is SYNCHRONOUS — `validateRegistrationsOnce`
    // runs before the handler ever reaches the app — and this asserts the refusal, not its timing.
    await expect(
      (async () => worker.fetch!(new Request('https://x.test/health'), noEnv, noCtx))(),
    ).rejects.toThrow(/file-storage/)
  })

  it('boot-validates the INJECTED generative-binary-integration registry', async () => {
    const binaryGeneratorRegistry = defaultBinaryGeneratorRegistry()
    binaryGeneratorRegistry.register({
      id: 'retro-diffusion',
      name: 'Retro Diffusion',
      summary: 'Pixel-art image generation.',
      description: 'Sprites and tiles.',
      modalities: ['image'],
      // Plain http off loopback, with a credential riding every request — the registration that
      // would otherwise put that key on the wire from inside a run container.
      endpoint: 'http://api.retrodiffusion.ai/v1',
      credential: { key: 'RD_TOKEN' },
    })
    const worker = createWorker({ overrides: { binaryGeneratorRegistry } })
    await expect(
      (async () => worker.fetch!(new Request('https://x.test/health'), noEnv, noCtx))(),
    ).rejects.toThrow(/retro-diffusion/)
  })

  it('leaves the default export validating the platform defaults (an empty estate is valid)', async () => {
    // The counterpart assertion: with nothing injected, the same boot path passes — so the case
    // above is the injected registry being read, not validation failing for everyone.
    const worker = createWorker()
    // `/health` needs no binding; reaching a non-throwing response proves boot validation passed.
    await expect(
      (async () => worker.fetch!(new Request('https://x.test/health'), noEnv, noCtx))(),
    ).resolves.toBeTruthy()
  })
})

import { describe, expect, it } from 'vitest'
import type { BinaryGeneratorView } from '../domain/binary-generator-registry.js'
import { defaultBinaryGeneratorRegistry } from '../domain/binary-generator-registry.js'
import { memoizeBinaryGeneratorViews, registryBinaryGeneratorSource } from './binary-generators.js'
import type { BinaryGeneratorSource } from './binary-generators.js'

/**
 * The per-dispatch memo in front of a {@link BinaryGeneratorSource}.
 *
 * Two halves of one dispatch ask the same question — the brief that tells an agent which
 * integrations it has, and the credential projection that puts a value behind each — and on a
 * mothership-mode node that question is a network round trip. The memo makes it ONE, without
 * becoming a cache: it is created inside a single read wave and discarded with it, so it has no
 * staleness window to reason about.
 *
 * Its sharp edge is the failure path. A shared promise that REJECTS is an unhandled rejection the
 * moment one of the two consumers short-circuits before awaiting it (a kind without the trait
 * never asks), which on Node is a process-level warning and, under `--unhandled-rejections=strict`,
 * a crash — from a source that was merely unreachable.
 */

function views(id: string): BinaryGeneratorView[] {
  const registry = defaultBinaryGeneratorRegistry()
  registry.register({
    id,
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: '',
    modalities: ['image'],
    credential: { key: 'RD_TOKEN' },
  })
  return registry.views()
}

/** A source counting its reads, so "once" is asserted rather than assumed. */
function counting(result: () => Promise<BinaryGeneratorView[]>): BinaryGeneratorSource & {
  reads: () => number
} {
  let reads = 0
  return {
    views: () => {
      reads += 1
      return result()
    },
    documentsFor: async () => new Map(),
    reads: () => reads,
  }
}

describe('memoizeBinaryGeneratorViews', () => {
  it('reads the source ONCE however many consumers ask', async () => {
    const source = counting(async () => views('retro-diffusion'))
    const memo = memoizeBinaryGeneratorViews(source)
    const [a, b, c] = await Promise.all([memo.views(), memo.views(), memo.views()])
    expect(source.reads()).toBe(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a[0]!.id).toBe('retro-diffusion')
  })

  it('reads once across SEQUENTIAL callers too, not only a concurrent wave', async () => {
    // The two consumers sit in one `Promise.all` today, but nothing in the port says they must —
    // a memo that only collapsed concurrent reads would silently stop working the day one of
    // them moved behind an `await`.
    const source = counting(async () => views('retro-diffusion'))
    const memo = memoizeBinaryGeneratorViews(source)
    await memo.views()
    await memo.views()
    expect(source.reads()).toBe(1)
  })

  it('gives EVERY consumer the original failure, and still only reads once', async () => {
    // Each caller keeps its own disposition (the brief degrades to absent, the credential
    // projection to none), so both must actually see the error rather than one of them getting
    // a cached empty set.
    const boom = new Error('mothership unreachable')
    const source = counting(async () => {
      throw boom
    })
    const memo = memoizeBinaryGeneratorViews(source)
    await expect(memo.views()).rejects.toBe(boom)
    await expect(memo.views()).rejects.toBe(boom)
    expect(source.reads()).toBe(1)
  })

  it('never leaves a REJECTED promise stored, so an un-awaited read cannot go unhandled', () => {
    // The reason the memo keeps a settled RESULT rather than the raw promise: a dispatch whose
    // other consumer short-circuits (a kind without the `binary-output` trait never asks for the
    // brief) would otherwise leave a rejected promise with nothing attached to it — a Node
    // `unhandledRejection`, and a crash under `--unhandled-rejections=strict`, from a source
    // that was merely unreachable. Asserted structurally here because kernel is runtime-neutral
    // and has no Node globals to hook; `run-catalog-context.test.ts` pins the runtime behaviour
    // on the facade side, where the memo is actually created.
    const memo = memoizeBinaryGeneratorViews({
      views: async () => {
        throw new Error('mothership unreachable')
      },
      documentsFor: async () => new Map(),
    })
    // Nobody ever awaits this one. If the memo stored the raw rejection, THIS is the tick that
    // would arm the warning.
    const first = memo.views()
    expect(first).toBeInstanceOf(Promise)
    // Attach a handler so the assertion itself is not the thing under test.
    return expect(first).rejects.toThrow('mothership unreachable')
  })

  it('passes `documentsFor` straight through — it is read once per dispatch already', async () => {
    const registry = defaultBinaryGeneratorRegistry()
    registry.register({
      id: 'retro-diffusion',
      name: 'Retro Diffusion',
      summary: '',
      description: '',
      modalities: ['image'],
      credential: { key: 'RD_TOKEN' },
      contracts: [{ contractId: 'api', format: 'openapi', title: 'API', body: '{}' }],
    })
    const memo = memoizeBinaryGeneratorViews(registryBinaryGeneratorSource(registry))
    const documents = await memo.documentsFor(['retro-diffusion'])
    expect(documents.get('retro-diffusion')).toHaveLength(1)
  })
})

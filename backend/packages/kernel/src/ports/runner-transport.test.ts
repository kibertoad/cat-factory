import { describe, expect, it } from 'vitest'
import {
  containerKeyForRef,
  isImageVariantName,
  parseContainerKey,
  PLATFORM_IMAGE_VARIANTS,
  runIdFromContainerKey,
} from './runner-transport.js'

// The container-identity pair. Both facades' per-run container backends derive a job's container
// from these, and three call sites have to agree on the answer with nothing passed between them:
// the dispatch that starts the container, the poll that addresses it again (from another
// process, after a durable replay), and the reaper that kills it if the run leaks it.

describe('containerKeyForRef', () => {
  it('is the bare run id for the default image', () => {
    // The common case, and the one that must not change shape: every existing container, every
    // inventory row and every label was written under the plain run id.
    expect(containerKeyForRef({ runId: 'run-1', jobId: 'coder' })).toBe('run-1')
    expect(containerKeyForRef({ runId: 'run-1', jobId: 'coder', image: 'default' })).toBe('run-1')
  })

  it('qualifies the run id for a non-default image', () => {
    // A run holds one container per image: its `tester-ui` step cannot share the container its
    // coder step is running in, because a per-run container cannot change image mid-run.
    expect(containerKeyForRef({ runId: 'run-1', jobId: 'tester', image: 'ui' })).toBe('ui:run-1')
    expect(containerKeyForRef({ runId: 'run-1', jobId: 'deploy', image: 'deploy' })).toBe(
      'deploy:run-1',
    )
  })

  it('gives two variants of one run distinct keys', () => {
    const ordinary = containerKeyForRef({ runId: 'run-1', jobId: 'coder' })
    const browser = containerKeyForRef({ runId: 'run-1', jobId: 'tester', image: 'ui' })
    expect(ordinary).not.toBe(browser)
  })
})

describe('runIdFromContainerKey', () => {
  it('recovers the run id from either key shape', () => {
    expect(runIdFromContainerKey('run-1')).toBe('run-1')
    expect(runIdFromContainerKey('ui:run-1')).toBe('run-1')
  })

  it('round-trips every variant', () => {
    // The property the orphan sweep depends on: it asks "is this run still live?" about the key
    // a container carries, so a key it cannot map back names no run, and a live browser
    // container gets swept out from under a run that is mid-step.
    for (const image of ['default', 'ui', 'deploy'] as const) {
      const key = containerKeyForRef({ runId: 'run-1', jobId: 'j', image })
      expect(runIdFromContainerKey(key)).toBe('run-1')
    }
  })

  it('keeps a run id that itself contains a colon intact', () => {
    // Run ids are minted ids today, but the inverse must not corrupt one that is not: only the
    // FIRST separator is the variant, so everything after it is the run.
    expect(runIdFromContainerKey('ui:run:with:colons')).toBe('run:with:colons')
  })

  it('leaves a key whose prefix could not be a variant WHOLE', () => {
    // The direction that destroys data. A key carrying a colon for any other reason (a job-id
    // scheme, an operator-created label, a future id shape) is not one this pair produced, and
    // truncating it yields a run id that matches no run, which is exactly what makes the orphan
    // sweep delete a live container. Variant names are open, so what is checkable is the SHAPE
    // every declaring boundary holds a name to: a prefix outside it is one no registration could
    // have declared. `default` is unsplittable for a different reason: `containerKeyForRef` never
    // emits it as a prefix, so a key spelling it out came from somewhere else.
    expect(runIdFromContainerKey('Bootstrap:ws1')).toBe('Bootstrap:ws1')
    expect(runIdFromContainerKey('job_id:ws1')).toBe('job_id:ws1')
    expect(runIdFromContainerKey('default:run-1')).toBe('default:run-1')
  })
})

describe('parseContainerKey', () => {
  it('reports the variant a key was qualified with, and none for a bare run id', () => {
    expect(parseContainerKey('ui:run-1')).toEqual({ runId: 'run-1', image: 'ui' })
    expect(parseContainerKey('run-1')).toEqual({ runId: 'run-1' })
  })

  it("round-trips a platform variant AND a deployment's own through containerKeyForRef", () => {
    // What an adapter re-encoding the key into a name (Apple `container`, whose names cannot hold
    // a colon) has to preserve: the variant AND the run, or its inverse cannot answer either.
    // A deployment's own name rides the same path, which is the whole reason the prefix test is
    // a shape rather than a lookup in the platform's list.
    for (const image of [...PLATFORM_IMAGE_VARIANTS, 'pixel-tools']) {
      const parsed = parseContainerKey(containerKeyForRef({ runId: 'run-1', jobId: 'j', image }))
      expect(parsed.runId).toBe('run-1')
      expect(parsed.image ?? 'default').toBe(image)
    }
  })
})

describe('isImageVariantName', () => {
  it("accepts the platform's own names and a deployment's, and nothing unshaped", () => {
    // Derived from the platform picklist rather than restated, so a name added there without the
    // shape rule agreeing fails here rather than being narrowed away at run time. The negatives
    // are what the container-key inverse leans on: each is a spelling a declaring boundary
    // refuses, so a key prefixed with one was never a variant.
    for (const image of PLATFORM_IMAGE_VARIANTS) expect(isImageVariantName(image)).toBe(true)
    expect(isImageVariantName('pixel-tools')).toBe(true)
    expect(isImageVariantName('Bootstrap')).toBe(false)
    expect(isImageVariantName('job_id')).toBe(false)
    expect(isImageVariantName('-leading')).toBe(false)
    expect(isImageVariantName('')).toBe(false)
    expect(isImageVariantName('x'.repeat(65))).toBe(false)
  })
})

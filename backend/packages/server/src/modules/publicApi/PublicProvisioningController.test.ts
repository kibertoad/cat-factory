import { describe, expect, it } from 'vitest'
import type { Block, BootstrapJob } from '@cat-factory/contracts'
import { toBlockPatch, toPublicBootstrapJob } from './PublicProvisioningController.js'
import { toPublicService } from './boardProjection.js'

// The two mappers whose bugs are SILENT, which is why they are the ones tested here rather than the
// routes around them. Every other property of this controller is already guarded structurally: the
// scope floor fails OpenAPI generation when absent, the surface table fails SDK generation when an
// operation has no entry, and each delegate is the app's own service method. These two are where a
// wrong answer still looks like a right one.

const frame = (overrides: Partial<Block> = {}): Block =>
  ({
    id: 'blk_1',
    title: 'Catalog API',
    description: 'the catalog',
    level: 'frame',
    type: 'service',
    status: 'ready',
    ...overrides,
  }) as Block

describe('toBlockPatch', () => {
  it('omits provisioning entirely when the caller did not send one', () => {
    // The trap this exists for: `updateBlock` patches the keys PRESENT on the object, so spreading
    // an absent `provisioning` through as `undefined` would clear the stored value. A caller
    // correcting a title would silently un-deploy the service, and nothing would report it until a
    // later run's deploy step read an empty manifest source.
    expect('provisioning' in toBlockPatch({ title: 'Renamed' })).toBe(false)
  })

  it('carries an empty patch as an empty patch rather than inventing keys', () => {
    expect(toBlockPatch({})).toEqual({})
  })

  it('passes a supplied provisioning through with its manifest source intact', () => {
    const patch = toBlockPatch({
      provisioning: {
        type: 'kubernetes',
        manifestSource: { type: 'colocated', path: 'deploy/k8s', renderer: 'raw' },
      },
    })
    expect(patch.provisioning).toEqual({
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s', renderer: 'raw' },
    })
  })

  it('distinguishes an empty-string description from an omitted one', () => {
    // `''` is a real edit (clear the description) and `undefined` is "leave it alone". Collapsing
    // them with a truthiness check would make clearing a description impossible through this route.
    expect(toBlockPatch({ description: '' })).toEqual({ description: '' })
    expect('description' in toBlockPatch({ title: 'x' })).toBe(false)
  })
})

describe('toPublicService', () => {
  it('projects a kubernetes provisioning so a caller can confirm what it just set', () => {
    const projected = toPublicService(
      frame({
        provisioning: {
          type: 'kubernetes',
          manifestSource: { type: 'colocated', path: 'deploy/k8s', renderer: 'raw' },
        },
      } as Partial<Block>),
    )
    expect(projected.provisioning?.manifestSource.path).toBe('deploy/k8s')
  })

  it('reports NOTHING for an engine this surface does not publish, never a coerced value', () => {
    // `docker-compose` has no member in the public union. Answering with the nearest one would tell
    // a caller its service deploys from manifests it never declared, which is worse than silence:
    // the caller would then "confirm" a provisioning that is not what the platform stored.
    const projected = toPublicService(
      frame({
        provisioning: { type: 'docker-compose', composePath: 'compose.yml' },
      } as Partial<Block>),
    )
    expect(projected.provisioning).toBeUndefined()
  })

  it('reports nothing for a kubernetes provisioning that names no manifest source', () => {
    // Half-declared is not declared: the deploy step reads this as "no manifests", so projecting a
    // `type` with no source would report a service as provisioned when nothing can be applied.
    const projected = toPublicService(
      frame({ provisioning: { type: 'kubernetes' } } as Partial<Block>),
    )
    expect(projected.provisioning).toBeUndefined()
  })

  it('omits provisioning for a service that declares none', () => {
    expect(toPublicService(frame()).provisioning).toBeUndefined()
  })
})

describe('toPublicBootstrapJob', () => {
  const job = (overrides: Partial<BootstrapJob> = {}): BootstrapJob =>
    ({
      id: 'bsj_1',
      workspaceId: 'ws_1',
      referenceArchitectureId: null,
      referenceArchitectureName: null,
      repoName: 'payments-api',
      repoOwner: null,
      repoUrl: null,
      instructions: 'build it',
      status: 'running',
      blockId: 'blk_1',
      subtasks: null,
      error: null,
      failure: null,
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    }) as BootstrapJob

  it('names the board frame as a serviceId, which is what the rest of the surface calls it', () => {
    expect(toPublicBootstrapJob(job()).serviceId).toBe('blk_1')
  })

  it('flattens all three human-readable parts of a failure, not just the kind', () => {
    // `hint` is the platform's own "where to look next". Dropping it would leave a headless caller
    // re-deriving a worse version of a sentence the deployment already wrote.
    const projected = toPublicBootstrapJob(
      job({
        status: 'failed',
        error: 'the repository is not empty',
        failure: {
          kind: 'preflight',
          message: 'the repository is not empty',
          detail: 'found 3 files at the default branch',
          hint: 'bootstrap targets an empty repository; pick another name',
          occurredAt: 3,
          lastSubtasks: null,
        },
      }),
    )
    expect(projected.failureKind).toBe('preflight')
    expect(projected.failureDetail).toBe('found 3 files at the default branch')
    expect(projected.failureHint).toBe('bootstrap targets an empty repository; pick another name')
  })

  it('reports every failure field as null when nothing faulted', () => {
    const projected = toPublicBootstrapJob(job({ status: 'succeeded' }))
    expect([projected.failureKind, projected.failureDetail, projected.failureHint]).toEqual([
      null,
      null,
      null,
    ])
  })

  it('reports a recorded kind outside the bootstrap-documented subset rather than dropping it', () => {
    // The stored value is the shared `agentFailure`, so a kind the bootstrap docs do not list is
    // still a kind a row can hold. Dropping it would report a failed run as having no
    // classification on the one path whose job is to say what went wrong.
    const projected = toPublicBootstrapJob(
      job({
        status: 'failed',
        failure: {
          kind: 'stalled',
          message: 'no progress',
          detail: null,
          hint: null,
          occurredAt: 3,
          lastSubtasks: null,
        },
      }),
    )
    expect(projected.failureKind).toBe('stalled')
  })
})

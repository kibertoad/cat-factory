import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  publicBootstrapJobSchema,
  publicKubernetesManifestSourceSchema,
  publicKubernetesUrlSourceSchema,
  publicVcsConnectionSchema,
  updatePublicServiceSchema,
} from './public-provisioning.js'

// The half of the deployment-provisioning surface that a typecheck cannot hold still.
//
// Its header states one rule with one exception: every STRUCTURAL shape is a projection, and the
// shared closed VOCABULARIES are imported instead, because duplicating a picklist buys nothing a
// projection buys and creates a stale-value hazard of its own. That exception is only honest if
// something notices when one of those vocabularies loses a member, which is what this file is:
// `/api/v1` is frozen (ADR 0034), so removing or renaming a published member is a public break,
// and the repo's own rules make that edit an ordinary, free-looking change everywhere else.
//
// What it asserts is CONTAINMENT, not equality, because the two directions are not the same fact.
// ADD a member and nothing is broken: the SDKs tolerate unknown enum values by design and an
// addition ships freely, so an equality pin would fail on every ordinary change and train the next
// person to re-pin it unread. REMOVE or rename one and four released clients lose a constant a
// consumer compiled against. Only the second is what this guards, and a failure here names the
// member that went missing.

/** The published members of a picklist, read the way the emitter reads them. */
const membersOf = (schema: { options: readonly string[] }): readonly string[] => schema.options

/** The published members of a discriminated variant, by its discriminant's literals. */
const variantMembers = (
  schema: { options: readonly { entries: Record<string, unknown> }[] },
  discriminant: string,
): string[] =>
  schema.options.map((option) => (option.entries[discriminant] as { literal: string }).literal)

describe('the shared vocabularies this surface publishes', () => {
  it('still publishes every bootstrap status a caller polls on', () => {
    expect(membersOf(publicBootstrapJobSchema.entries.status)).toEqual(
      expect.arrayContaining(['pending', 'running', 'succeeded', 'failed']),
    )
  })

  it('still publishes every agent failure kind a caller branches on', () => {
    // The widest of the shared vocabularies and the one most likely to be edited: the harness
    // classifies fault modes, and a kind retired there silently retires a published constant.
    expect(membersOf(publicBootstrapJobSchema.entries.failureKind.wrapped)).toEqual(
      expect.arrayContaining([
        'preflight',
        'dispatch',
        'environment',
        'evicted',
        'timeout',
        'agent',
        'job_failed',
        'rejected',
        'companion_rejected',
        'stalled',
        'cancelled',
        'unknown',
      ]),
    )
  })

  it('still publishes both VCS providers and both connect methods', () => {
    expect(membersOf(publicVcsConnectionSchema.entries.provider)).toEqual(
      expect.arrayContaining(['github', 'gitlab']),
    )
    expect(membersOf(publicVcsConnectionSchema.entries.method)).toEqual(
      expect.arrayContaining(['app', 'pat']),
    )
  })
})

describe('the Kubernetes shapes this surface projects', () => {
  it('still publishes both manifest sources and all five URL sources', () => {
    expect(variantMembers(publicKubernetesManifestSourceSchema, 'type')).toEqual(
      expect.arrayContaining(['colocated', 'separate']),
    )
    expect(variantMembers(publicKubernetesUrlSourceSchema, 'source')).toEqual(
      expect.arrayContaining([
        'ingressTemplate',
        'ingressStatus',
        'serviceStatus',
        'gatewayStatus',
        'httpRouteStatus',
      ]),
    )
  })

  it('carries the validation of the internal shape it projects, not only its field names', () => {
    // A projection that dropped the `owner/repo` rule would accept a manifest repo the engine
    // cannot resolve, and the refusal would arrive on a deploy step instead of at the door.
    expect(() =>
      v.parse(publicKubernetesManifestSourceSchema, {
        type: 'separate',
        repo: 'no-slash',
        path: 'k8s',
      }),
    ).toThrow()
    expect(
      v.parse(publicKubernetesManifestSourceSchema, {
        type: 'separate',
        repo: 'acme/manifests',
        path: 'k8s',
      }),
    ).toEqual({ type: 'separate', repo: 'acme/manifests', path: 'k8s' })
  })
})

describe('updatePublicServiceSchema', () => {
  it('refuses a patch that names no field', () => {
    // The generated clients DEFAULT the body, so `services.update(id)` is one keystroke away from
    // a request that spends a write, a re-read and a board-wide event on a no-op.
    expect(() => v.parse(updatePublicServiceSchema, {})).toThrow()
  })

  it('admits a patch naming any single field, including a cleared description', () => {
    expect(v.parse(updatePublicServiceSchema, { description: '' })).toEqual({ description: '' })
    expect(v.parse(updatePublicServiceSchema, { title: 'Catalog API' })).toEqual({
      title: 'Catalog API',
    })
  })
})

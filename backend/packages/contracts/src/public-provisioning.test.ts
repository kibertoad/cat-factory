import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { manifestIdSchema } from './environments.js'
import { kubernetesUrlSourceSchema } from './environments-kubernetes.js'
import {
  linkPublicRepoSchema,
  publicBootstrapJobSchema,
  publicEnvironmentHandlerSchema,
  publicKubernetesManifestSourceSchema,
  publicKubernetesUrlSourceSchema,
  publicRepoFilePathSchema,
  publicRiskPolicySchema,
  publicServiceProvisioningSchema,
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

  it('still publishes both autonomy postures, which decide whether a headless run can finish', () => {
    // The one vocabulary on this surface a caller BRANCHES ON before it starts anything: under
    // `attended` a run can park on a judgement call the caller has nobody to make, so losing a
    // member here is losing the caller's ability to tell those two deployments apart.
    expect(membersOf(publicRiskPolicySchema.entries.autonomy)).toEqual(
      expect.arrayContaining(['attended', 'unattended']),
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

  it('projects the ingress-template PORT, so the public half cannot lag the internal one', () => {
    // The port has to be its own field rather than part of `hostTemplate`, because the rendered
    // template is also the Ingress `spec.rules[].host` the manifests declare and Kubernetes rejects
    // a `host` carrying a port. Present internally and absent here, a caller could set the template
    // over `/api/v1` and have no way to say which port serves it.
    const withPort = {
      source: 'ingressTemplate',
      hostTemplate: '{{namespace}}.127.0.0.1.nip.io',
      port: 18080,
      scheme: 'http',
    }
    expect(v.parse(publicKubernetesUrlSourceSchema, withPort)).toMatchObject({ port: 18080 })
    expect(v.parse(kubernetesUrlSourceSchema, withPort)).toMatchObject({ port: 18080 })
    // And it is a real port on both sides, not merely a number that rides through.
    for (const schema of [publicKubernetesUrlSourceSchema, kubernetesUrlSourceSchema]) {
      expect(() => v.parse(schema, { ...withPort, port: 70000 })).toThrow()
    }
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

  it('admits a null provisioning as the one field that IS the patch', () => {
    // `null` is a real edit (clear the pin), so it has to satisfy the at-least-one-field check the
    // same way a title does. Read through `!== undefined`, which is what keeps the two apart:
    // omitted leaves the stored pin alone, and only an explicit null clears it.
    expect(v.parse(updatePublicServiceSchema, { provisioning: null })).toEqual({
      provisioning: null,
    })
  })

  it('still refuses a provisioning that is neither a member nor null', () => {
    // The null widens what is accepted and nothing else: a garbled variant is still a 400 rather
    // than a pin stored as a shape no deploy can read.
    expect(() => v.parse(updatePublicServiceSchema, { provisioning: { type: 'nomad' } })).toThrow()
  })
})

describe('linkPublicRepoSchema', () => {
  it('accepts a GitLab namespace PATH as the owner, which is what the available read publishes', () => {
    // A GitLab project lives under nested groups, so its owner reads `group/subgroup`. Refusing the
    // slash made a nested-group project unadoptable through this surface at all: the row the
    // discovery read published could not be fed back into the adopt, and no id-taking alternative
    // exists to fall back on.
    expect(v.parse(linkPublicRepoSchema, { owner: 'group/sub', name: 'payments' })).toEqual({
      owner: 'group/sub',
      name: 'payments',
    })
    expect(v.parse(linkPublicRepoSchema, { owner: 'acme', name: 'payments' }).owner).toBe('acme')
  })

  it('refuses a path EXPRESSION, which is what separates a namespace from a traversal', () => {
    // The reason the field is segmented rather than "a string with slashes in it": each segment is
    // still a name, so an empty, `.` or `..` segment is refused at the boundary rather than being
    // handed to a provider path builder to interpret.
    for (const owner of ['/acme', 'acme/', 'acme//sub', 'acme/../other', 'acme/.', 'a b/c']) {
      expect(() => v.parse(linkPublicRepoSchema, { owner, name: 'payments' })).toThrow()
    }
  })

  it('still refuses a slash in the NAME, which is one segment on every provider', () => {
    expect(() => v.parse(linkPublicRepoSchema, { owner: 'acme', name: 'a/b' })).toThrow()
  })
})

describe('the service-provisioning variant', () => {
  it('still publishes both provision types a caller can pin', () => {
    // `custom` is what lets a deployment shipping its OWN environment backend say so at all. Losing
    // it would leave a Kargo-pinned service and an unpinned one answering identically, which is the
    // state the read half was added to make checkable.
    expect(variantMembers(publicServiceProvisioningSchema, 'type')).toEqual(
      expect.arrayContaining(['kubernetes', 'custom']),
    )
  })

  it('accepts exactly the manifest ids the INTERNAL grammar accepts', () => {
    // The public id format is restated rather than imported, which is this surface's rule for a
    // STRUCTURAL shape: an internal tightening inherited here would refuse a value a live
    // integration is already pinning, and that is a break nobody reviewed as one. The two are meant
    // to agree, so this is what notices when they stop, in EITHER direction: a public value
    // the internal side refuses is a pin that stores and then resolves nothing.
    const candidates = [
      'kargo',
      'k',
      'nomad-preview',
      'a1-b2',
      'Kargo',
      'kargo_preview',
      '-kargo',
      'kargo ',
      '',
      'x'.repeat(65),
    ]
    const publicVerdicts = candidates.map(
      (value) =>
        v.safeParse(publicServiceProvisioningSchema, { type: 'custom', manifestId: value }).success,
    )
    const internalVerdicts = candidates.map(
      (value) => v.safeParse(manifestIdSchema, value.trim()).success,
    )
    expect(publicVerdicts).toEqual(internalVerdicts)
  })
})

describe('the environment-handler list', () => {
  it('reports `engine` as an open string, so a registered backend is not coerced', () => {
    // The connect call's own view pins `engine: 'kubernetes'`, truthfully, because that is the only
    // engine this surface REGISTERS. A list has to report what a deployment SEEDED, including a
    // backend it registered in code, and widening that shipped literal would retype a field a
    // released client already narrows on. Hence a second shape rather than a change to the first.
    expect(
      v.safeParse(publicEnvironmentHandlerSchema, {
        provisionType: 'custom',
        manifestId: null,
        acceptsManifestId: 'kargo',
        engine: 'remote-custom',
        backendKind: 'kargo',
        label: 'Kargo',
        endpoint: 'https://kargo.example',
        secretKeys: ['apiToken'],
        connectedAt: 1,
      }).success,
    ).toBe(true)
  })

  it('carries BOTH manifest-id fields, because the engine matches a service against either', () => {
    // `resolveInfraHandler` → `matchesCustom` accepts a pinned id keyed on `manifestId` OR declared as
    // `acceptsManifestId`, and each way of registering a handler sets only one of them. Publishing one
    // made a seeded handler read as a handler serving nothing, which is the very question this list
    // exists to answer.
    expect(Object.keys(publicEnvironmentHandlerSchema.entries)).toContain('manifestId')
    expect(Object.keys(publicEnvironmentHandlerSchema.entries)).toContain('acceptsManifestId')
  })
})

describe('the repo-file read', () => {
  it('refuses a path that means something other than what it says', () => {
    // Not a security boundary and it does not claim to be one: the read is already scoped to a
    // repository this workspace LINKED. What it buys is an honest refusal, since answering a
    // traversal as `file_not_found` sends someone hunting for a file that is right where they left it.
    const accepts = (path: string) => v.safeParse(publicRepoFilePathSchema, path).success
    expect(accepts('deploy/preview.yaml')).toBe(true)
    expect(accepts('.kargo.yml')).toBe(true)
    expect(accepts('/etc/passwd')).toBe(false)
    expect(accepts('deploy/../../secrets')).toBe(false)
    expect(accepts('   ')).toBe(false)
  })
})

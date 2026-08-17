import { describe, expect, it } from 'vitest'
import type {
  Block,
  BootstrapJob,
  EnvironmentHandlerView,
  GitHubAvailableRepo,
  GitHubConnection,
  PublicEnvironmentHandler,
  ServiceProvisioning,
} from '@cat-factory/contracts'
import { publicEnvironmentHandlerSchema } from '@cat-factory/contracts'
import {
  RateLimitedError,
  UnavailableError,
  VcsApiError,
  VcsBlobTooLargeError,
  type RunRepoContext,
} from '@cat-factory/kernel'
import { GitHubApiError } from '../../github/githubHttpHelpers.js'
import type { RepoUseByRepoId } from '@cat-factory/orchestration'
import type { ServerContainer } from '../../http/env.js'
import {
  asVcsRefusal,
  byHandlerIdentity,
  readGradableFile,
  readVcsConnection,
  toBlockPatch,
  toPublicAvailableRepo,
  toPublicBootstrapJob,
  toPublicHandler,
} from './PublicProvisioningController.js'
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
    expect('provisioning' in toBlockPatch({ title: 'Renamed' }, undefined)).toBe(false)
  })

  it('passes a supplied provisioning through with its manifest source intact', () => {
    const patch = toBlockPatch(
      {
        provisioning: {
          type: 'kubernetes',
          manifestSource: { type: 'colocated', path: 'deploy/k8s', renderer: 'raw' },
        },
      },
      undefined,
    )
    expect(patch.provisioning).toEqual({
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s', renderer: 'raw' },
    })
  })

  it('keeps the stored fields this surface cannot express', () => {
    // The data-loss this exists for: `provisioning` is ONE json column, replaced wholesale, and a
    // service configured in the app carries far more than the two fields published here. Writing
    // just the pair would drop the image overrides and the Secret injections an operator authored,
    // and the next deploy would come up with neither — from a caller that only fixed a path.
    const patch = toBlockPatch(
      {
        provisioning: {
          type: 'kubernetes',
          manifestSource: { type: 'colocated', path: 'deploy/prod' },
        },
      },
      {
        type: 'kubernetes',
        manifestSource: { type: 'colocated', path: 'deploy/k8s' },
        images: [{ name: 'api', newTagTemplate: '{{sha}}' }],
        secretInjections: [{ mode: 'secret', secretName: 'db', entries: [{ key: 'PGPASSWORD' }] }],
      } as ServiceProvisioning,
    )
    expect(patch.provisioning).toMatchObject({
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/prod' },
      images: [{ name: 'api', newTagTemplate: '{{sha}}' }],
      secretInjections: [{ mode: 'secret', secretName: 'db', entries: [{ key: 'PGPASSWORD' }] }],
    })
  })

  it('replaces rather than overlays when the provision type changes', () => {
    // The remainder describes the type being left behind: a compose path carried onto a kubernetes
    // provisioning would attach one engine's configuration to another.
    const patch = toBlockPatch(
      {
        provisioning: {
          type: 'kubernetes',
          manifestSource: { type: 'colocated', path: 'deploy/k8s' },
        },
      },
      { type: 'docker-compose', composePath: 'compose.yml' } as ServiceProvisioning,
    )
    expect(patch.provisioning).toEqual({
      type: 'kubernetes',
      manifestSource: { type: 'colocated', path: 'deploy/k8s' },
    })
  })

  it('lowers a CUSTOM pin, keeping the stored remainder it belongs to', () => {
    // The write half of the custom variant: a service reaching a deployment's own environment
    // backend is pinned by a manifest id the deployment registered, and nothing about the backend
    // itself crosses this surface. The overlay rule is the kubernetes one unchanged.
    const patch = toBlockPatch(
      { provisioning: { type: 'custom', manifestId: 'kargo', manifestPath: '.kargo.yml' } },
      { type: 'custom', manifestId: 'kargo', localDevOnly: true } as ServiceProvisioning,
    )
    expect(patch.provisioning).toEqual({
      type: 'custom',
      manifestId: 'kargo',
      manifestPath: '.kargo.yml',
      localDevOnly: true,
    })
  })

  it('leaves manifestPath OFF a custom pin that named none', () => {
    // Written through as `undefined` it would pin the empty path, and the deploy would look for the
    // manifest at the repository root rather than falling back to the type's own default.
    const patch = toBlockPatch({ provisioning: { type: 'custom', manifestId: 'kargo' } }, undefined)
    expect(patch.provisioning).toEqual({ type: 'custom', manifestId: 'kargo' })
  })

  it('CLEARS a stored manifestPath the patch left out, while keeping what it cannot express', () => {
    // `manifestPath` is the one stored field this surface publishes, so an omission is the only way a
    // caller can say "back to the type's default". Carried over from the stored row it would keep
    // deploying the old path with nothing reporting it, and the public shape offers no other way to
    // clear it. Everything the public shape cannot express still survives.
    const patch = toBlockPatch({ provisioning: { type: 'custom', manifestId: 'kargo' } }, {
      type: 'custom',
      manifestId: 'kargo',
      manifestPath: 'deploy/old.yml',
      localDevOnly: true,
    } as ServiceProvisioning)
    expect(patch.provisioning).toEqual({ type: 'custom', manifestId: 'kargo', localDevOnly: true })
  })

  it('distinguishes an empty-string description from an omitted one', () => {
    // `''` is a real edit (clear the description) and `undefined` is "leave it alone". Collapsing
    // them with a truthiness check would make clearing a description impossible through this route.
    expect(toBlockPatch({ description: '' }, undefined)).toEqual({ description: '' })
    expect('description' in toBlockPatch({ title: 'x' }, undefined)).toBe(false)
  })
})

describe('readVcsConnection', () => {
  const connection = { provider: 'gitlab', accountLogin: 'acme', method: 'pat' } as GitHubConnection

  it('reads a GitLab-only deployment through the PAT connect service', () => {
    // The refusal this exists for: a GitLab-only deployment builds NO `github` module (that module
    // needs the App's webhook verifier), so reading only the module answered "source control is
    // not configured" at a workspace whose connection is sitting in the database.
    const container = { vcsConnectionService: { getConnection: async () => connection } }
    return expect(
      readVcsConnection(container as unknown as ServerContainer, 'ws_1'),
    ).resolves.toEqual(connection)
  })

  it('prefers the module when both are wired, since that is the one that routes by provider', () => {
    const container = {
      github: { installationService: { getConnection: async () => connection } },
      vcsConnectionService: {
        getConnection: async () => {
          throw new Error('the PAT service must not be consulted when the module is present')
        },
      },
    }
    return expect(
      readVcsConnection(container as unknown as ServerContainer, 'ws_1'),
    ).resolves.toEqual(connection)
  })

  it('refuses with a 503 when this deployment wires no source control at all', async () => {
    await expect(readVcsConnection({} as ServerContainer, 'ws_1')).rejects.toBeInstanceOf(
      UnavailableError,
    )
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
    expect(
      projected.provisioning?.type === 'kubernetes' && projected.provisioning.manifestSource.path,
    ).toBe('deploy/k8s')
  })

  it('projects a CUSTOM provisioning, so a pinned service is not read as an unpinned one', () => {
    // The gap this closes: a service reaching a deployment's own environment backend used to land in
    // the "cannot describe it" hole below, so a Kargo-pinned service and a service pinned to nothing
    // answered identically. Those are the two states a headless setup check most needs apart, and
    // the omission made "unmet" and "could not be read" collapse into each other.
    const projected = toPublicService(
      frame({
        provisioning: { type: 'custom', manifestId: 'kargo', manifestPath: 'deploy/.kargo.yml' },
      } as Partial<Block>),
    )
    expect(projected.provisioning).toEqual({
      type: 'custom',
      manifestId: 'kargo',
      manifestPath: 'deploy/.kargo.yml',
    })
  })

  it('reports nothing for a CUSTOM provisioning naming no manifest id', () => {
    // The id is what matches the service to a handler, so a `custom` without one resolves no backend.
    // Publishing `{ type: 'custom' }` would report a half-written pin as a configuration that deploys.
    const projected = toPublicService(frame({ provisioning: { type: 'custom' } } as Partial<Block>))
    expect(projected.provisioning).toBeUndefined()
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

describe('toPublicAvailableRepo', () => {
  const reachable = (overrides: Record<string, unknown> = {}) =>
    ({
      githubId: 101,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      private: true,
      linked: false,
      ...overrides,
    }) as GitHubAvailableRepo

  /** No service in the account holds anything: the default the reads below are not about. */
  const unclaimed: RepoUseByRepoId = new Map()

  it('renames the provider id to the neutral field a service create takes', () => {
    // The whole point of the read: what comes back has to be passable to `POST /api/v1/services`,
    // which takes `repo.repoId`. An internal `githubId` reaching the wire would also re-hardcode a
    // provider into a surface that is frozen forever.
    expect(toPublicAvailableRepo(reachable(), unclaimed).repoId).toBe(101)
  })

  it('states the two booleans the internal shape spells as absent-means-false', () => {
    // The silent bug this exists for: `isMonorepo` and `personal` are optional internally, so
    // passing the row through would publish a field that is missing on most rows and false on some.
    // A caller distinguishing "absent" from "false" would be distinguishing nothing.
    const projected = toPublicAvailableRepo(reachable(), unclaimed)
    expect(projected.monorepo).toBe(false)
    expect(projected.personal).toBe(false)
    expect(toPublicAvailableRepo(reachable({ isMonorepo: true }), unclaimed).monorepo).toBe(true)
  })

  it('answers the empty string for an unrecorded default branch, as the repos list does', () => {
    // Null would make a caller reading it to name a base decide between "unknown" and "main", and
    // there is nothing here that could invent the second.
    expect(toPublicAvailableRepo(reachable({ defaultBranch: null }), unclaimed).defaultBranch).toBe(
      '',
    )
  })

  it('falls back to `github` for a row with no provider, as every other read does', () => {
    expect(toPublicAvailableRepo(reachable(), unclaimed).provider).toBe('github')
    expect(toPublicAvailableRepo(reachable({ provider: 'gitlab' }), unclaimed).provider).toBe(
      'gitlab',
    )
  })

  it('reports a repository already backing a service on ANOTHER board as spoken for', () => {
    // The refusal `POST /api/v1/services` will raise, said at discovery time instead. The service's
    // own id is withheld (it names a block this key cannot read), so `serviceId: null` is the only
    // answer available and `linkedElsewhere` is what stops it reading as availability. A caller
    // that trusted the id alone would adopt a repository whose create then fails.
    const projected = toPublicAvailableRepo(
      reachable(),
      new Map([[101, { serviceBlockId: null, linkedElsewhere: true }]]),
    )
    expect(projected.serviceId).toBeNull()
    expect(projected.linkedElsewhere).toBe(true)
  })

  it('names the service on THIS board that already holds it', () => {
    const projected = toPublicAvailableRepo(
      reachable({ linked: true }),
      new Map([[101, { serviceBlockId: 'blk_1', linkedElsewhere: false }]]),
    )
    expect(projected.serviceId).toBe('blk_1')
    expect(projected.linkedElsewhere).toBe(false)
  })

  it('reads an absent verdict as free, because the map is built from these very ids', () => {
    const projected = toPublicAvailableRepo(reachable(), unclaimed)
    expect(projected.serviceId).toBeNull()
    expect(projected.linkedElsewhere).toBe(false)
  })
})

describe('asVcsRefusal', () => {
  // The adopt pair is the only place on this surface that reaches the provider on the request path,
  // so it is the only place a failure can be neither the caller's fault nor the platform's. Each
  // branch here is a wrong answer that would otherwise look right: a revoked token reported as an
  // internal fault sends a headless caller to file a platform bug about a credential only they can
  // replace, and a rate limit reported as anything but retryable stops a setup script for good.

  it('re-raises a rejected credential as a 503 naming the connection, not an internal fault', () => {
    for (const status of [401, 403]) {
      const refusal = asVcsRefusal(new GitHubApiError(status, 'Bad credentials'))
      expect(refusal).toBeInstanceOf(UnavailableError)
      expect((refusal as UnavailableError).details).toMatchObject({
        reason: 'vcs_credential_rejected',
      })
    }
  })

  it('reads the rate-limit FLAG rather than the status, which GitHub reports as 403', () => {
    // A primary rate-limit exhaustion and a permission denial are the same number, so status alone
    // would tell a caller to re-mint a token that is working perfectly and will work again shortly.
    const refusal = asVcsRefusal(new GitHubApiError(403, 'rate limit exceeded', true))
    expect(refusal).toBeInstanceOf(RateLimitedError)
    expect((refusal as RateLimitedError).details).toMatchObject({ reason: 'vcs_rate_limited' })
  })

  it("classifies ANOTHER provider's refusal identically, since a workspace may connect either", () => {
    // Keyed on the shared `VcsApiError` rather than the GitHub class: a GitLab-connected workspace
    // reaches the same routes through the same service and throws `GitLabApiError`, and a
    // GitHub-only check answered its revoked token with the 500 this function exists to prevent.
    // Raised as the BASE class here because this package cannot see `@cat-factory/gitlab` (nor
    // should it); that the GitLab client's error IS one is pinned in that package's own suite.
    const rejected = asVcsRefusal(new VcsApiError('gitlab', 401, '401 Unauthorized'))
    expect(rejected).toBeInstanceOf(UnavailableError)
    expect((rejected as UnavailableError).details).toMatchObject({
      reason: 'vcs_credential_rejected',
    })
    // GitLab reports an exhausted quota as a plain 429 and carries no flag to read, so the status
    // has to be enough on its own.
    const limited = asVcsRefusal(new VcsApiError('gitlab', 429, 'Too Many Requests'))
    expect(limited).toBeInstanceOf(RateLimitedError)
    expect((limited as RateLimitedError).details).toMatchObject({ reason: 'vcs_rate_limited' })
  })

  it('propagates everything else, so a provider outage stays a 500', () => {
    // The refusals above are claims about the workspace's credential. A 500 from the provider, or a
    // bug in this platform, is not one, and dressing either as a connection problem would send an
    // operator to replace a credential that is fine.
    const outage = new GitHubApiError(502, 'Bad gateway')
    expect(asVcsRefusal(outage)).toBe(outage)
    const bug = new TypeError('undefined is not a function')
    expect(asVcsRefusal(bug)).toBe(bug)
  })
})

describe('toPublicHandler', () => {
  const handler = (overrides: Partial<EnvironmentHandlerView> = {}): EnvironmentHandlerView =>
    ({
      provisionType: 'kubernetes',
      manifestId: null,
      engine: 'remote-kubernetes',
      providerId: 'prov_1',
      label: 'staging cluster',
      baseUrl: 'https://cluster.example:6443',
      connectedAt: 1_700_000_000_000,
      secretKeys: ['apiToken'],
      acceptsManifestId: null,
      backendKind: 'kubernetes',
      ...overrides,
    }) as EnvironmentHandlerView

  it('reports a handler for a deployment-registered backend AS ITSELF, never coerced', () => {
    // The reason the list does not reuse the connect call's view, whose `engine` is the literal
    // `kubernetes`. This read exists so a caller can confirm a programmatically-seeded handler
    // landed, and reporting a Kargo handler as a Kubernetes one would answer that question wrongly
    // while looking like an answer.
    expect(
      toPublicHandler(
        handler({
          provisionType: 'custom',
          engine: 'remote-custom',
          backendKind: 'kargo',
          acceptsManifestId: 'kargo',
          baseUrl: 'https://kargo.example',
        }),
      ),
    ).toEqual({
      provisionType: 'custom',
      manifestId: null,
      acceptsManifestId: 'kargo',
      engine: 'remote-custom',
      backendKind: 'kargo',
      label: 'staging cluster',
      endpoint: 'https://kargo.example',
      secretKeys: ['apiToken'],
      connectedAt: 1_700_000_000_000,
    })
  })

  it('reports a handler KEYED to a manifest id, which is the shape a seed produces', () => {
    // The field the engine's own `matchesCustom` checks FIRST, and the one a deployment seeding a
    // handler from its composition root sets: `acceptsManifestId` is set only by a `remote-custom`
    // connection. Published alone, the commonest seed shape read as a handler serving nothing, so a
    // setup script confirming its own seed landed found no entry naming it while a run against that
    // handler resolved perfectly.
    expect(
      toPublicHandler(handler({ provisionType: 'custom', manifestId: 'kargo' })),
    ).toMatchObject({ manifestId: 'kargo', acceptsManifestId: null })
  })

  it('publishes the secret KEYS and never the stored config they came from', () => {
    // `EnvironmentHandlerView` carries the whole non-secret config for the app's connect-form
    // prefill. It is the internal per-engine bag, deliberately open, and this surface may not freeze
    // it, so a field added there must not start appearing on `/api/v1`.
    const projected = toPublicHandler(
      handler({ config: { engine: 'remote-kubernetes' } } as Partial<EnvironmentHandlerView>),
    )
    // Derived from the published schema rather than restated, so adding a member there is a decision
    // made in one place: what this pins is that the projection answers EXACTLY the schema's fields,
    // which is the property that keeps the internal config bag from leaking onto `/api/v1`.
    expect(Object.keys(projected).sort()).toEqual(
      Object.keys(publicEnvironmentHandlerSchema.entries).sort(),
    )
  })
})

describe('byHandlerIdentity', () => {
  const entry = (overrides: Partial<PublicEnvironmentHandler>): PublicEnvironmentHandler =>
    ({
      provisionType: 'custom',
      manifestId: null,
      acceptsManifestId: null,
      engine: 'remote-custom',
      backendKind: 'kargo',
      label: 'a handler',
      endpoint: 'https://kargo.example',
      secretKeys: [],
      connectedAt: 1,
      ...overrides,
    }) as PublicEnvironmentHandler

  it('orders by CODE UNITS, so the same set serialises identically on every runtime', () => {
    // `localeCompare` collates, and its collation depends on the ICU build and the ambient locale:
    // workerd, a full-ICU Node and a small-ICU Node can disagree, which is exactly the spurious diff
    // the ordering exists to prevent. `_` (0x5F) sorts AFTER every uppercase letter by code unit and
    // before them under most collations, so this pins the difference rather than a spelling.
    const sorted = [entry({ manifestId: 'a_b' }), entry({ manifestId: 'aB' })]
      .sort(byHandlerIdentity)
      .map((handler) => handler.manifestId)
    expect(sorted).toEqual(['aB', 'a_b'])
  })

  it('separates two custom handlers keyed to different manifests', () => {
    // With only `acceptsManifestId` in the key, two seeded handlers tied and fell back to whatever
    // order the repository read returned: two runs of the same setup check could disagree.
    const sorted = [entry({ manifestId: 'nomad' }), entry({ manifestId: 'kargo' })]
      .sort(byHandlerIdentity)
      .map((handler) => handler.manifestId)
    expect(sorted).toEqual(['kargo', 'nomad'])
  })
})

describe('readGradableFile', () => {
  const repo = (getFile: RunRepoContext['repo']['getFile']): RunRepoContext['repo'] =>
    ({ getFile }) as RunRepoContext['repo']

  it('answers the OVER-LIMIT refusal for a blob the provider will not serve, not a 503', () => {
    // The misattribution this exists for: GitHub reports an over-limit blob as a 403, so
    // `asVcsRefusal` turned a 1.4 MB lockfile into "re-connect the workspace, a token may have been
    // revoked" and sent an operator to replace a credential that works.
    return expect(
      readGradableFile(
        repo(() => Promise.reject(new VcsBlobTooLargeError('github', 1_048_576))),
        'acme/api:pnpm-lock.yaml',
        'pnpm-lock.yaml',
        undefined,
      ),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'file_too_large', limit: 1_048_576 },
    })
  })

  it('refuses bytes that are not UTF-8 rather than answering the replacement characters', () => {
    // A PNG or a tarball decodes to U+FFFD, and handing that back under a field documented as the
    // file's content is the lie the size cap already refuses to tell: a caller comparing against its
    // own copy sees a mismatch it cannot attribute. The `sha` rides the refusal, so the byte-exact
    // join a grader wanted is still available.
    return expect(
      readGradableFile(
        repo(async () => ({ content: '��', sha: 'deadbeef', lossy: true })),
        'acme/api:logo.png',
        'logo.png',
        undefined,
      ),
    ).rejects.toMatchObject({ details: { reason: 'file_not_text', sha: 'deadbeef' } })
  })

  it('passes an omitted ref through OMITTED, so the provider resolves the real default branch', async () => {
    // `context.baseBranch` is the wrong value to substitute: `makeResolveRepoFilesForCoords` invents
    // `main` for a projection row carrying no default branch, so a repository whose default is
    // `master` would be read at a branch it does not have and answer `file_not_found` for a file that
    // is right there.
    const asked: (string | undefined)[] = []
    const file = await readGradableFile(
      repo(async (_path, gitRef) => {
        asked.push(gitRef)
        return { content: 'ok', sha: 'abc' }
      }),
      'acme/api:README.md',
      'README.md',
      undefined,
    )
    expect(asked).toEqual([undefined])
    expect(file?.content).toBe('ok')
  })

  it('re-raises any OTHER provider failure through the credential/rate-limit mapping', async () => {
    await expect(
      readGradableFile(
        repo(() => Promise.reject(new GitHubApiError(401, 'Bad credentials'))),
        'acme/api:README.md',
        'README.md',
        'main',
      ),
    ).rejects.toBeInstanceOf(UnavailableError)
  })
})

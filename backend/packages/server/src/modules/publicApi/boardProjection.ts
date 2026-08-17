import {
  publicKubernetesRendererSchema,
  type Block,
  type KubernetesManifestSource,
  type PublicKubernetesManifestSource,
  type PublicRepo,
  type PublicService,
  type PublicServiceProvisioning,
  type PublicTask,
} from '@cat-factory/contracts'
import type { PublicRepoOption } from '@cat-factory/orchestration'

// The `Block` → public-resource projections, shared by every controller that answers with one.
//
// Their own module because there are now two: the task lifecycle (`PublicApiController`) and board
// provisioning (`PublicBoardController`) both hand a block back, and a projection defined beside one
// of them is a projection the other copies. That copy is the failure mode worth avoiding rather than
// a tidiness point: a field added to `publicTask` in one place and not the other does not fail to
// compile: the second surface simply keeps serving a response the contract says has the field, and
// a consumer reads its absence as the value being unset.

/** Project a board task block onto the external task resource. */
export function toPublicTask(block: Block, serviceId: string): PublicTask {
  return {
    taskId: block.id,
    serviceId,
    title: block.title,
    description: block.description,
    taskType: block.taskType ?? 'feature',
    status: block.status,
    progress: block.progress,
    // The public name is `runId`, one vocabulary with `publicRun.runId` and `/runs/:runId/...`;
    // `executionId` is the internal engine name for the same id.
    runId: block.executionId,
    pullRequestUrl: block.pullRequest?.url ?? null,
    dependsOn: block.dependsOn,
    // Absent is OFF, which is what the engine's post-merge hook reads it as: a task nobody has
    // toggled leaves its dependents to be started deliberately.
    autoStartDependents: block.autoStartDependents === true,
    // Null, never the default's id: a task pinning nothing FOLLOWS the workspace default, so
    // resolving one in here would report a task as pinned that moves the day the default does.
    // The row spells "unpinned" as absent OR as the empty string (`addTask` treats both alike).
    modelPresetId: block.modelPresetId || null,
    riskPolicyId: block.riskPolicyId || null,
  }
}

/**
 * Project a service frame block onto the external service resource.
 *
 * `provisioning` is projected only for the shapes this surface publishes. A service provisioned
 * through a type this build cannot describe reports NOTHING here rather than a coerced value: the
 * public union cannot express it, and answering with the nearest member would tell a caller its
 * service deploys from manifests it never declared.
 *
 * That omission is deliberately as SMALL as the surface allows, because it is indistinguishable from
 * an unpinned service. A Kargo-backed (or any other custom-backend) service used to land in it, so a
 * headless caller could not tell "pinned to something I cannot read" from "pinned to nothing", which
 * are the two states an acceptance prerequisite most needs apart. `custom` now projects, which
 * leaves the hole covering only a type added to the internal picklist and not to the public one.
 */
export function toPublicService(frame: Block): PublicService {
  return {
    serviceId: frame.id,
    title: frame.title,
    description: frame.description,
    type: frame.type,
    status: frame.status,
    ...toPublicProvisioning(frame.provisioning),
  }
}

/**
 * The `provisioning` key, or nothing when this surface cannot describe what is stored.
 *
 * Answers the KEY rather than the value so the caller spreads one expression: an `undefined` value
 * spread into the object would put the field on the wire as absent-but-present, which valibot and
 * the SDK read differently from a field that was never there.
 *
 * A stored `custom` with no `manifestId` reports nothing, and that is not pedantry: the id is what
 * matches the service to a handler, so a `custom` without one is a half-written pin that resolves no
 * backend, and publishing `{ type: 'custom' }` would report it as a configuration that will deploy.
 */
function toPublicProvisioning(
  provisioning: Block['provisioning'],
): { provisioning: PublicServiceProvisioning } | null {
  if (provisioning?.type === 'kubernetes') {
    const manifestSource = provisioning.manifestSource
      ? toPublicManifestSource(provisioning.manifestSource)
      : null
    return manifestSource ? { provisioning: { type: 'kubernetes', manifestSource } } : null
  }
  if (provisioning?.type === 'custom' && provisioning.manifestId) {
    return {
      provisioning: {
        type: 'custom',
        manifestId: provisioning.manifestId,
        ...(provisioning.manifestPath === undefined
          ? {}
          : { manifestPath: provisioning.manifestPath }),
      },
    }
  }
  return null
}

/**
 * Lift a stored manifest source onto the published one, or null when this surface cannot describe
 * it.
 *
 * The public shape is a PROJECTION of the internal one rather than the internal one (see the
 * contracts header), so the lift is explicit in both directions. Null is the same disposition the
 * caller above already takes for a non-Kubernetes engine, and it is what makes a stored value this
 * build cannot express (a source kind or a renderer added by a deployment ahead of this one)
 * report as "nothing published" rather than as a manifest source with a member silently dropped.
 */
function toPublicManifestSource(
  source: KubernetesManifestSource,
): PublicKubernetesManifestSource | null {
  if (source.renderer !== undefined && !PUBLIC_RENDERERS.has(source.renderer)) return null
  const renderer = source.renderer === undefined ? {} : { renderer: source.renderer }
  if (source.type === 'colocated') return { type: 'colocated', path: source.path, ...renderer }
  if (source.type === 'separate') {
    return {
      type: 'separate',
      repo: source.repo,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      path: source.path,
      ...renderer,
    }
  }
  return null
}

/**
 * The renderers this surface publishes, DERIVED from the public picklist rather than restated, so
 * adding one there is all it takes for a stored value to start being reported.
 */
const PUBLIC_RENDERERS: ReadonlySet<string> = new Set(publicKubernetesRendererSchema.options)

/**
 * Project one repo option onto the wire, dropping the installation/sync bookkeeping.
 *
 * Here rather than beside `GET /api/v1/repos` because two routes now answer with this shape: that
 * list, and `POST /api/v1/repos/link`, which reports the row it adopted so a caller can chain
 * straight into service creation. The link route re-reads the same `listRepoOptions` to build it
 * instead of deriving `serviceId` / `linkedElsewhere` for itself: those two are one judgement about
 * where a service is homed (account-scoped, and deliberately withholding an id this key could not
 * address), and a second derivation is how the adopt call and the list come to disagree about
 * whether a repository is free.
 */
export function toPublicRepo(option: PublicRepoOption): PublicRepo {
  const { repo, serviceBlockId, linkedElsewhere } = option
  return {
    repoId: repo.githubId,
    // Absent on rows written before the column existed, which the platform reads as `github`
    // everywhere else; stating that here keeps the wire field non-null for every row.
    provider: repo.provider ?? 'github',
    owner: repo.owner,
    name: repo.name,
    // A repo whose default branch has not been projected yet answers with the empty string rather
    // than null: a caller reads it to name a base, and there is nothing here that could invent one.
    defaultBranch: repo.defaultBranch ?? '',
    private: repo.private,
    monorepo: repo.isMonorepo === true,
    serviceId: serviceBlockId,
    linkedElsewhere,
  }
}

import {
  publicKubernetesRendererSchema,
  type Block,
  type KubernetesManifestSource,
  type PublicKubernetesManifestSource,
  type PublicService,
  type PublicTask,
} from '@cat-factory/contracts'

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
 * `provisioning` is projected only for the shapes this surface publishes (today `kubernetes`). A
 * service provisioned through another engine reports NOTHING here rather than a coerced value: the
 * public union cannot describe it, and answering with the nearest member would tell a caller its
 * service deploys from manifests it never declared.
 */
export function toPublicService(frame: Block): PublicService {
  const provisioning = frame.provisioning
  const manifestSource =
    provisioning?.type === 'kubernetes' && provisioning.manifestSource
      ? toPublicManifestSource(provisioning.manifestSource)
      : null
  return {
    serviceId: frame.id,
    title: frame.title,
    description: frame.description,
    type: frame.type,
    status: frame.status,
    ...(manifestSource ? { provisioning: { type: 'kubernetes' as const, manifestSource } } : {}),
  }
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

import type { ProvisionType, ServiceProvisioning, WorkspaceSettings } from '@cat-factory/contracts'
import type { Block, Logger, ServiceFragmentDefaultsRepository } from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'
import type { WorkspaceSettingsReader } from './workspaceSettingsReader.js'

/**
 * Where to place a frame the caller did not position: the next slot on a 5-wide grid, sized to the
 * frames the board already carries.
 *
 * Beside the seeds above for the same reason they are together: BOTH frame-creation paths need it,
 * and the one that had it kept its own copy while `addFrame` demanded a position outright. So the
 * moment a caller with no canvas needed a frame (the public API's service creation), the choice was
 * either to publish a coordinate system into a frozen surface or to invent a third layout rule.
 *
 * It is only a STARTING point: a service's position on any board is its per-board mount, which a
 * human moves. Overlap is possible on a board whose frames were all dragged elsewhere, and that is
 * fine: the alternative is a placement search that pretends to know where the user wants it.
 */
export function nextFrameSlot(blocks: readonly Block[]): { x: number; y: number } {
  const frames = blocks.filter((block) => block.level === 'frame').length
  return { x: 80 + (frames % 5) * 48, y: 80 + Math.floor(frames / 5) * 48 }
}

/**
 * Everything a NEWLY CREATED SERVICE FRAME inherits from its workspace — today the default
 * best-practice fragment selection and the default test-environment provisioning mechanism.
 * Extracted from {@link BoardService} as a cohesive collaborator (the file-size ratchet's
 * split trigger, and the same shape as {@link ReviewFrictionGuard}): both frame-creation paths
 * — the drag-drop `addFrame` and the import-a-repo `addServiceFromRepo` — need the identical
 * set, so keeping them together is what stops one path quietly acquiring a seed the other lacks.
 *
 * Every seed here is BEST-EFFORT and CREATION-TIME.
 *
 * Best-effort: a defaults read that fails degrades that seed to absent rather than failing the
 * board mutation the user actually asked for. Creating the service matters more than decorating
 * it, and both seeds remain editable afterwards.
 *
 * Creation-time, not a run-time fallback, and the difference is deliberate: the engine reads only
 * a service's OWN `provisioning`, so changing the workspace default never retroactively alters
 * what an existing service provisions. That keeps it a suggestion the user owns, exactly like
 * the repo auto-detection it sits beside. Without it a service frame is born declaring nothing,
 * which every reader treats as `infraless` — so a workspace running Kubernetes preview
 * environments had to re-declare that per service, and a service silently produced no test
 * environment until somebody noticed.
 */

/** The workspace-level seeds a new service frame is created with. */
export interface NewServiceFrameDefaults {
  /** The workspace's default best-practice fragment selection; empty when none is set. */
  serviceFragmentIds: string[]
  /** The workspace's default provisioning, or absent when it has recorded no choice. */
  provisioning?: ServiceProvisioning
}

/** The seams the defaults are read through. Each is optional; an absent one yields no seed. */
export interface NewServiceFrameDefaultsDeps {
  settings?: WorkspaceSettingsReader
  serviceFragmentDefaults?: ServiceFragmentDefaultsRepository
  logger: Logger
}

/**
 * Resolve every seed for a new service frame in one call, so a caller can't apply one and
 * forget the other. The two reads are independent, so they run concurrently: frame creation
 * pays the slower of them, not their sum.
 */
export async function resolveNewServiceFrameDefaults(
  workspaceId: string,
  deps: NewServiceFrameDefaultsDeps,
): Promise<NewServiceFrameDefaults> {
  const [serviceFragmentIds, provisioning] = await Promise.all([
    resolveDefaultServiceFragmentIds(workspaceId, deps),
    resolveDefaultProvisioning(workspaceId, deps),
  ])
  return { serviceFragmentIds, ...(provisioning ? { provisioning } : {}) }
}

/**
 * The workspace's default service-fragment selection. Empty when the defaults repo isn't wired,
 * none is set, or the read fails — frame creation is never blocked by a defaults read.
 */
export async function resolveDefaultServiceFragmentIds(
  workspaceId: string,
  deps: Pick<NewServiceFrameDefaultsDeps, 'serviceFragmentDefaults' | 'logger'>,
): Promise<string[]> {
  const repo = deps.serviceFragmentDefaults
  if (!repo) return []
  const ids = await runBestEffort(
    deps.logger,
    'board.defaultServiceFragmentIds',
    () => repo.get(workspaceId),
    { workspaceId },
  )
  return ids ?? []
}

/**
 * The provisioning to stamp on a new service frame, or `undefined` to leave the frame with
 * none (byte-for-byte the pre-existing behaviour).
 *
 * Pure so the precedence is unit-testable without a repository. Two settings shapes yield
 * `undefined`:
 *  - `defaultProvisionType: null` — the operator has never chosen. Seeding `infraless` here
 *    would be indistinguishable from a real choice AND would silently write a decision nobody
 *    made onto every service.
 *  - `custom` with no `defaultProvisionManifestId` — a `custom` service with no pinned id
 *    matches no `remote-custom` handler, so seeding it would mint services that can never
 *    provision and fail only much later, at the deployer step. `WorkspaceSettingsService`
 *    rejects that combination at the write boundary; this is the defence in depth for a row
 *    written before the validation existed, or by a direct repository write.
 */
export function defaultProvisioningFor(
  settings: Pick<WorkspaceSettings, 'defaultProvisionType' | 'defaultProvisionManifestId'>,
): ServiceProvisioning | undefined {
  const type: ProvisionType | null = settings.defaultProvisionType
  if (type == null) return undefined
  if (type === 'custom') {
    const manifestId = settings.defaultProvisionManifestId
    return manifestId ? { type, manifestId } : undefined
  }
  return { type }
}

/**
 * Resolve the seed for a new service frame in a workspace, reading through the settings seam.
 *
 * BEST-EFFORT by construction: an unwired reader (tests, conformance, a minimal facade) or a
 * failing settings read yields `undefined`, so a settings-store hiccup degrades a new service
 * to "declares nothing" — the old behaviour, editable in the inspector — rather than failing
 * the board mutation the user actually asked for. The swallow is reported through the kernel
 * logger so a persistently broken read is diagnosable instead of invisible.
 */
export async function resolveDefaultProvisioning(
  workspaceId: string,
  deps: Pick<NewServiceFrameDefaultsDeps, 'settings' | 'logger'>,
): Promise<ServiceProvisioning | undefined> {
  const reader = deps.settings
  if (!reader) return undefined
  const settings = await runBestEffort(
    deps.logger,
    'board.defaultProvisioning',
    () => reader.get(workspaceId),
    { workspaceId },
  )
  return settings ? defaultProvisioningFor(settings) : undefined
}

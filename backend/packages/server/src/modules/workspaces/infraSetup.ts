import type { InfraSetup, InfraSetupArea } from '@cat-factory/contracts'
import { getErrorMessage } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/kernel'
import { logger as sharedLogger } from '../../observability/logger.js'

// The per-area infrastructure-SETUP projection: which infra areas this deployment uses, and
// whether the operator has wired each one. Extracted from `WorkspaceController` because it now has
// TWO consumers that must not disagree — the board snapshot (which reports an area's status) and
// the reachability watcher (which probes an area's saved connection). See
// {@link infraSetupAreaApplies} for why that pairing is a correctness constraint rather than a
// tidiness one.

/**
 * The per-area infrastructure-setup status for a workspace, computed from whatever THIS
 * deployment actually wired (so it's runtime-symmetric by construction — the shared controller
 * derives it, no per-facade code). Each area is:
 *  - `not_applicable` — the integration isn't wired for this runtime (nothing to configure), so
 *    the read function is absent, or the area does not APPLY here (see
 *    {@link infraSetupAreaApplies}).
 *  - `not_defined`    — the deployment CAN use it but the operator hasn't set it up (banner-worthy):
 *    no environment/runner-pool connection registered, or the account selected no content-storage
 *    backend (Node defaults to `off`).
 *  - `configured`     — a connection / backend is defined.
 *  - `unreachable`    — configured, but the reachability watcher's live probe cannot reach it. NOT
 *    produced here: it is folded on from the watcher's record by `applyInfraReachability`, so the
 *    board-load path never probes.
 *
 * IMPORTANT: this is an ADVISORY projection for a banner — it must never break the workspace
 * snapshot (the board load). Each area's read is fault-isolated: a read that throws (e.g. a
 * mothership persistence RPC that doesn't expose the connection repo, or a rotated encryption key
 * that fails a secret decrypt) OR hangs past {@link AREA_PROBE_TIMEOUT_MS} degrades that area to
 * `not_applicable` ("can't tell → don't nag") rather than 500-ing / stalling `GET /workspaces/:id`.
 * A swallowed error/timeout is logged (best-effort) so a persistent misconfig that reads as
 * `not_applicable` is still diagnosable instead of silently invisible.
 */

/** Cap on a single area probe so a slow/stuck backend read can't stall the whole board snapshot. */
const AREA_PROBE_TIMEOUT_MS = 2000

export async function areaStatus(
  wired: boolean,
  read: () => Promise<unknown>,
  opts: { area?: string; logger?: Logger; timeoutMs?: number } = {},
): Promise<'not_applicable' | 'not_defined' | 'configured'> {
  if (!wired) return 'not_applicable'
  const timeoutMs = opts.timeoutMs ?? AREA_PROBE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`infra-setup probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
    return result ? 'configured' : 'not_defined'
  } catch (err) {
    opts.logger?.warn('infra-setup probe failed; degrading area to not_applicable', {
      area: opts.area,
      err: getErrorMessage(err),
    })
    return 'not_applicable'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The subset of the request container the infra-setup projection reads. Named (rather than inlined)
 * so the presence-probe method shapes are explicit and a signature change is caught here.
 *
 * The env/runner probes use `hasConnection` — a yes/no that does NOT decrypt the secret bundle.
 * `resolveBinaryArtifactStore` is the store's single source of truth (an account can select a
 * backend whose credentials don't yet resolve, which a presence-only check couldn't tell from a
 * live one); it reads through the AccountSettingsService's short-TTL cache, so the underlying
 * secret decrypt is amortized across board loads rather than paid on each.
 */
export interface InfraSetupSources {
  environments?: { connectionService: { hasConnection(ws: string): Promise<boolean> } }
  runners?: { connectionService: { hasConnection(ws: string): Promise<boolean> } }
  /**
   * True ONLY when a self-hosted runner pool is the sole execution backend for container agents
   * (so an unregistered pool means NO agent can run) — i.e. this facade has no built-in per-run
   * container runtime. Only remote/stock Node sets it: Cloudflare has built-in per-run containers
   * and local mode runs agents in per-run HOST containers, so on both the pool is an OPTIONAL
   * alternate target, not the executor of record. Without this gate the mere presence of the
   * (always-wired-on-Node, opt-in-on-Cloudflare) runner surface would falsely nag "no agent can
   * run" on local mode and on a Cloudflare deployment that set `RUNNERS_ENABLED`.
   */
  agentExecutorRequiresRunnerPool?: boolean
  /**
   * True when an ephemeral-environment PROVIDER connection is genuinely mandatory for env-dependent
   * Tester runs — i.e. this deployment has no zero-config in-container test-env default. Gates the
   * `ephemeralEnvironments` area exactly like `agentExecutorRequiresRunnerPool` gates the executor:
   * local mode on a Docker-family runtime stands the Tester's deps up with `local-compose` (no
   * connection), so a missing provider must NOT nag there. Defaults to required (`?? true`) when
   * unset, preserving the Worker / stock-Node behaviour (their only test-env backend needs a
   * provider). See `testEnvHasZeroConfigDefault`.
   */
  ephemeralEnvironmentsRequireProvider?: boolean
  resolveBinaryArtifactStore?: (ws: string) => Promise<unknown>
}

/**
 * Whether an infra area APPLIES to this deployment at all — the one predicate behind both the
 * projection's `not_applicable` verdict and the reachability watcher's decision to probe.
 *
 * It has to be one definition, because the two paths converge on one banner and the failure of
 * disagreement is silent. The watcher gated only on "is the module wired", which is strictly
 * looser: `agentExecutorRequiresRunnerPool` is unset on Cloudflare and false on local mode, so a
 * dead-but-optional runner pool raised a card, paged Slack and pushed `unreachable` for an area the
 * projection then refused to fold (`applyInfraSetupTransition` only downgrades a `configured`
 * area). The result was an outage nobody could see on reload — a probe cost paid to report nothing.
 * A deployment that does not use an area must not be told it is down.
 */
export function infraSetupAreaApplies(sources: InfraSetupSources, area: InfraSetupArea): boolean {
  switch (area) {
    case 'ephemeralEnvironments':
      return !!sources.environments && (sources.ephemeralEnvironmentsRequireProvider ?? true)
    case 'agentExecutor':
      return !!sources.runners && !!sources.agentExecutorRequiresRunnerPool
    case 'binaryStorage':
      return !!sources.resolveBinaryArtifactStore
  }
}

export async function snapshotInfraSetup(
  container: InfraSetupSources,
  workspaceId: string,
  logger: Logger = sharedLogger,
): Promise<InfraSetup> {
  const [ephemeralEnvironments, agentExecutor, binaryStorage] = await Promise.all([
    areaStatus(
      infraSetupAreaApplies(container, 'ephemeralEnvironments'),
      () => container.environments!.connectionService.hasConnection(workspaceId),
      { area: 'ephemeralEnvironments', logger },
    ),
    areaStatus(
      infraSetupAreaApplies(container, 'agentExecutor'),
      () => container.runners!.connectionService.hasConnection(workspaceId),
      { area: 'agentExecutor', logger },
    ),
    areaStatus(
      infraSetupAreaApplies(container, 'binaryStorage'),
      () => container.resolveBinaryArtifactStore!(workspaceId),
      { area: 'binaryStorage', logger },
    ),
  ])
  return { ephemeralEnvironments, agentExecutor, binaryStorage }
}

import { ConflictError } from '@cat-factory/kernel'
import { DOCS } from '../config/docs.js'

/**
 * The single source of truth for the "no runner backend available" failure a facade's transport
 * resolver raises when neither a self-hosted runner pool nor a per-run container backend can serve
 * a workspace's job. Both runtime facades (Cloudflare and Node/local) throw THIS so the condition
 * is identical across runtimes rather than duplicated as two drifting throw sites:
 *
 *  - It is a {@link ConflictError} carrying the machine reason `agent_backend_unconfigured`, so it
 *    is a clean 409 synchronously AND `classifyDispatchFailure` lifts the reason onto the run's
 *    `AgentFailure` on the async dispatch path — the SPA renders the "Agent backend not configured"
 *    title + a jump to the setup, not the misleading "container failed to start".
 *  - The load-bearing `No runner backend available for workspace '<id>'` prefix is preserved
 *    (still greppable), and the UI-first remedy names the setup path first, then deepens with the
 *    runner-pool doc.
 *
 * @param workspaceId the workspace the job targeted (rendered as `(unknown)` when absent).
 * @param opts.cloudflareContainers when true the remedy also offers "enable Cloudflare Containers"
 *   — the Cloudflare facade has a per-run container backend the Node/local facades don't.
 */
export function noRunnerBackendAvailableError(
  workspaceId: string | undefined,
  opts?: { cloudflareContainers?: boolean },
): ConflictError {
  const cloudflareClause = opts?.cloudflareContainers
    ? ', or enable Cloudflare Containers in your deployment config'
    : ''
  return new ConflictError(
    `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': register a ` +
      `runner pool in Settings → Self-hosted runner pool (or point the workspace at a ` +
      `Kubernetes cluster)${cloudflareClause}. See ${DOCS.runnerPool()}.`,
    'agent_backend_unconfigured',
  )
}

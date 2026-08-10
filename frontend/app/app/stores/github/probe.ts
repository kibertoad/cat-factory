import type { Ref } from 'vue'
import type { GitHubPatCheck } from '~/types/domain'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import type { GitHubStoreContext } from '~/stores/github/context'

/**
 * The board-load probe: everything the store learns about the deployment's VCS setup in one round
 * trip, before anything is clicked.
 *
 * Three questions, deliberately not three failure modes:
 *  - Is the integration there at all, and what is bound? (`available` + `connection`)
 *  - What could be connected, for the not-connected UI? (`connectOptions`)
 *  - Can the token a run would use actually push? (`patCheck`)
 *
 * Extracted from the store setup when the credential check pushed it past the function-size
 * ratchet, and it is the right seam rather than a convenient one: these three reads share a
 * lifecycle (fired together on board open, reset together on workspace switch) and nothing else in
 * the store does.
 */
export function createGitHubProbe(
  ctx: GitHubStoreContext,
  patCheck: Ref<GitHubPatCheck | null>,
): { probe: () => Promise<void>; ensureProbed: () => Promise<void> } {
  const { api, workspace, available, connection, connectOptions } = ctx

  async function runProbe(): Promise<void> {
    if (!workspace.workspaceId) return
    // Started beside the connection read but settled OUTSIDE its try, deliberately. Local mode
    // reaches GitHub with a personal access token and wires no App module at all, so
    // `getGitHubConnection` 503s there — and that is precisely the deployment shape whose
    // credential this check is about. Folded into the same catch, the answer would be discarded
    // exactly where it matters most. A failure of its own leaves `null` (unknown), which the
    // banner reads as "nothing to say", never as "all clear".
    const checking = api.getGitHubPatCheck(workspace.requireId()).catch(() => null)
    try {
      const [{ connection: conn }, options] = await Promise.all([
        api.getGitHubConnection(workspace.requireId()),
        api
          .listVcsConnectOptions(workspace.requireId())
          .then((r) => r.options)
          .catch(() => []),
      ])
      available.value = true
      connection.value = conn
      connectOptions.value = options
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      connection.value = null
      connectOptions.value = []
    }
    patCheck.value = await checking
  }

  // Single-flight the probe (app-startup initiative, item 12): `probe()` still re-reads on demand,
  // but the on-board-open callers (the board page's onboarding gate + the SideBar) use
  // `ensureProbed()` so their duplicate fire collapses to one request per board. A workspace switch
  // (new id) re-probes.
  return useSingleFlightProbe(runProbe, () => workspace.workspaceId)
}

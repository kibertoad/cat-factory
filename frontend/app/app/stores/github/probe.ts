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
 *
 * The credential check is the odd one out in TWO ways, and both are why it is single-flighted
 * SEPARATELY rather than being a third branch of `runProbe`:
 *
 *  - It is the only read that leaves the deployment. The others answer from local rows in
 *    milliseconds; this one waits on GitHub, up to a `GET /user` plus a repository read each. So
 *    it is started beside them and never awaited by the caller: a modal that awaits `probe()` to
 *    learn whether the integration is available would otherwise sit behind a slow or unreachable
 *    GitHub for as long as those calls take, to render a banner it does not own.
 *  - It is a DIAGNOSTIC, not data any caller reads, so it follows the DOOR rather than the batch.
 *    `ensureProbed()` (the on-board-open fan-out) checks at most once per board; `probe()` (the
 *    deliberate-refresh door) re-checks, because the surfaces that force a refresh are the ones
 *    that just changed what the answer depends on: linking a repository to a service frame is
 *    what turns "this board targets no GitHub repository" into a verdict at all. A panel that
 *    merely wants to know whether the integration is available belongs on `ensureProbed()`, and
 *    the ones whose own comments said "probe once so the pickers light up" were moved onto it.
 */
export function createGitHubProbe(
  ctx: GitHubStoreContext,
  patCheck: Ref<GitHubPatCheck | null>,
): { probe: () => Promise<void>; ensureProbed: () => Promise<void> } {
  const { api, workspace, available, connection, connectOptions } = ctx

  async function runPatCheck(): Promise<void> {
    // Which board asked, captured BEFORE the await: a workspace switch mid-flight must not land
    // this board's verdict on the next one's banner. The single-flight wrapper re-keys on the id
    // but cannot un-assign a value the run already wrote.
    const askedFor = workspace.workspaceId
    if (!askedFor) return
    // A failure leaves the previous value alone rather than clearing it: `null` means "not
    // answered", which the banner reads as nothing to say, and overwriting a real verdict with
    // it would silently retract a warning the reader has not acted on.
    const check = await api.getGitHubPatCheck(askedFor).catch(() => null)
    if (check && workspace.workspaceId === askedFor) patCheck.value = check
  }

  const patProbe = useSingleFlightProbe(runPatCheck, () => workspace.workspaceId)

  async function runConnectionReads(): Promise<void> {
    if (!workspace.workspaceId) return
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
  }

  // Single-flight the connection reads (app-startup initiative, item 12): `probe()` still re-reads
  // on demand, but the on-board-open callers (the board page's onboarding gate + the SideBar) use
  // `ensureProbed()` so their duplicate fire collapses to one request per board. A workspace switch
  // (new id) re-probes.
  const connectionProbe = useSingleFlightProbe(runConnectionReads, () => workspace.workspaceId)

  // The credential check rides the same DOOR the caller opened but never its await, so a slow or
  // unreachable GitHub delays nothing a caller is waiting on. Awaiting only the connection reads
  // is what keeps `await github.probe()` a local-row read, which is what its callers treat it as.
  return {
    probe: () => {
      void patProbe.probe()
      return connectionProbe.probe()
    },
    ensureProbed: () => {
      void patProbe.ensureProbed()
      return connectionProbe.ensureProbed()
    },
  }
}

import type {
  AgentJobUpdate,
  AgentRunResult,
  ContainerEvictionKind,
  HarnessFailureCause,
  RunnerJobResult,
  RunnerJobView,
  StreamedFollowUp,
} from '@cat-factory/kernel'
import { type AgentKindRegistry, summaryOr } from '@cat-factory/agents'

/**
 * Runner-output → engine-result normalisation for {@link ContainerAgentExecutor}.
 *
 * These are the pure functions that turn a finished {@link RunnerJobResult} into the engine's
 * {@link AgentRunResult}. The KIND-AWARE half (blueprint / spec / merge / on-call / test) used to
 * be an `agentKind === …` chain here, the second of the two switches the agent-kind strangler set
 * out to delete; it is now one registry lookup, because every built-in declares its own
 * `mapStructuredResult` beside its dispatch shape. The output boundary of the executor, kept as a
 * self-contained, independently-testable unit.
 */

/**
 * Map a finished runner {@link RunnerJobResult} into the engine's {@link AgentRunResult}.
 * Every built-in agent now dispatches the single manifest-driven `agent` kind, so the
 * result carries either a structured `custom` JSON (explore agents), an opened `prUrl`
 * (the coder), or just `pushed` (the in-place fixers / conflict-resolver). No `model` here:
 * the proxy meters tokens and the async path doesn't carry the provider ref to the poll
 * site; `usage` is likewise omitted (metered by the proxy).
 *
 * The container agent's effort self-assessment (`result.effortReport`, lifted by the harness
 * from the agent's sentinel file) is attached to EVERY mapped result — it is orthogonal to
 * the kind-specific channels — so the engine records it on the step for run details.
 */
export function toRunResult(
  result: RunnerJobResult,
  agentKind: string | undefined,
  registry: AgentKindRegistry,
): AgentRunResult {
  const mapped =
    result.custom !== undefined
      ? coerceCustomResult(result, agentKind, registry)
      : mapPushOrPrResult(result)
  // The pre-PR validation report is orthogonal to the kind-specific channels (like
  // `effortReport`), so attach it to EVERY mapped result: on the success path it is the captured
  // proof the checkout was green BEFORE the PR opened — the whole point of the feature. A failed
  // job never reaches here; its report rides the `failed` update's `validationReport`.
  const withValidation = result.validationReport
    ? { ...mapped, validationReport: result.validationReport }
    : mapped
  // The bugfix reproduction proof, likewise orthogonal to the kind-specific channels. Attached on
  // the SUCCESS path too, and for every verdict: `inconclusive` is not a failure, it is the honest
  // statement that the reproduction could not be demonstrated — dropping it here would leave the
  // PR report unable to tell that apart from a run where the phase never ran at all.
  const withReproduction = result.reproductionReport
    ? { ...withValidation, reproductionReport: result.reproductionReport }
    : withValidation
  return result.effortReport
    ? { ...withReproduction, effortReport: result.effortReport }
    : withReproduction
}

/**
 * Coerce a structured `agent` job's parsed `custom` JSON into the engine's {@link AgentRunResult}.
 *
 * ONE registry lookup, no kind chain: a built-in whose reply the engine reads through a typed
 * channel it acts on (`mergeAssessment` gates the real merge, `testReport` greenlights the run or
 * loops the fixer, `spec` is sharded into the repo) declares that mapping on its own registration,
 * beside the dispatch shape that produced the reply. Every other kind — a deployment's own
 * structured explore agent, and any built-in with no engine channel — surfaces the raw JSON as
 * `custom` for its post-op to render from. Called only when `result.custom !== undefined`.
 */
function coerceCustomResult(
  result: RunnerJobResult,
  agentKind: string | undefined,
  registry: AgentKindRegistry,
): AgentRunResult {
  const mapStructured = agentKind ? registry.mapStructuredResult(agentKind) : undefined
  if (mapStructured) return mapStructured(result)
  return {
    output: summaryOr(result, 'Agent run complete.'),
    custom: result.custom,
  }
}

/**
 * Map a finished coding/fixer job (no structured `custom`) into the engine result: a PR the run
 * opened, an in-place push back onto the branch, or a clean no-op — carrying any peer PRs a
 * multi-repo run opened. Extracted from {@link toRunResult} to keep each function within the
 * complexity budget; behaviour is byte-identical.
 */
function mapPushOrPrResult(result: RunnerJobResult): AgentRunResult {
  // PRs a multi-repo run opened in connected services' repos (service-connections phase 3),
  // beside the own-service PR. Lifted onto `AgentRunResult.peerPullRequests` for the engine
  // to record on the block; absent for a single-repo run.
  const peerPullRequests = mapPeerPullRequests(result.peerPullRequests)
  // The peer PRs a multi-repo run opened, rendered for the human-readable output. Shared by
  // BOTH the own-PR branch and the no-own-PR branch below, so a run whose own service was a
  // no-op but a peer changed still lists the peer PR(s) instead of reading "No changes …".
  const peerNote = peerPullRequests?.length
    ? `\n${peerPullRequests.map((p) => `PR (${p.repo}): ${p.ref.url}`).join('\n')}`
    : ''
  // A coding job that opened a PR (the coder + any PR-opening coding agent): surface the PR
  // STRUCTURALLY so the engine records it on the block and the board links to it. Checked
  // BEFORE `pushed` — a coding run reports BOTH `pushed:true` AND `prUrl`, so the PR must win
  // over the in-place-fixer text below or it would be silently dropped.
  if (result.prUrl) {
    const summary = result.summary?.trim() || 'Implementation complete.'
    return {
      output: `${summary}\n\nPR: ${result.prUrl}${peerNote}`,
      pullRequest: {
        url: result.prUrl,
        ...(prNumberFromUrl(result.prUrl) !== undefined
          ? { number: prNumberFromUrl(result.prUrl) }
          : {}),
        ...(result.branch ? { branch: result.branch } : {}),
      },
      ...(peerPullRequests?.length ? { peerPullRequests } : {}),
      // A ralph iteration opens the PR on its first pass; carry its harness-computed
      // validation verdict so the ralph loop's completion interceptor can read it.
      ...(result.ralphVerdict ? { ralphVerdict: result.ralphVerdict } : {}),
    }
  }
  // An in-place coding job with no PR (ci-fixer / fixer / conflict-resolver): it pushed back
  // onto the existing branch (or was a clean no-op). The engine's CI / conflicts gate
  // re-checks the real signal regardless; map to a sensible output. The agent's own summary
  // is used when present (e.g. the conflict-resolver's "Resolved merge conflicts …"). A
  // multi-repo run whose OWN service was a no-op but a peer changed still surfaces the peer PRs
  // (both structurally and in the rendered output via `peerNote`).
  if (result.pushed !== undefined) {
    const base =
      result.summary?.trim() ||
      (result.pushed
        ? 'Pushed changes to the branch.'
        : peerPullRequests?.length
          ? 'No changes in the primary repository.'
          : 'No changes were produced.')
    return {
      output: `${base}${peerNote}`,
      ...(peerPullRequests?.length ? { peerPullRequests } : {}),
      // Later ralph iterations push to the same branch (no new PR); carry the verdict.
      ...(result.ralphVerdict ? { ralphVerdict: result.ralphVerdict } : {}),
    }
  }
  return { output: result.summary?.trim() || 'Implementation complete.' }
}

/**
 * Map a multi-repo run's peer-PR entries (harness `{ repo, frameId?, prUrl, branch }`) into
 * the engine's `AgentRunResult.peerPullRequests` (`{ repo, frameId?, ref: PullRequestRef }`),
 * deriving the PR number from the URL like the own-service PR. Returns undefined when the run
 * reported none, so a single-repo run's result is byte-identical to before.
 */
function mapPeerPullRequests(
  peers: RunnerJobResult['peerPullRequests'],
): AgentRunResult['peerPullRequests'] | undefined {
  if (!peers?.length) return undefined
  return peers.map((p) => ({
    repo: p.repo,
    ...(p.frameId ? { frameId: p.frameId } : {}),
    ref: {
      url: p.prUrl,
      ...(prNumberFromUrl(p.prUrl) !== undefined ? { number: prNumberFromUrl(p.prUrl) } : {}),
      ...(p.branch ? { branch: p.branch } : {}),
    },
  }))
}

/** Extract the PR number from a GitHub pull-request URL (`.../pull/42`). */
function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url)
  if (!match) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * Map a `running` runner view into the engine's `running` {@link AgentJobUpdate}: the live
 * subtask counts (so the step can surface "3/8 done"), the container's current lifecycle phase
 * and identity/address, the harness liveness heartbeat (which keeps a quiet-but-alive run's
 * `updated_at` fresh), and the latest pre-PR validation attempt (so the repair loop is visible
 * WHILE it runs rather than only at the end). Pure — the executor's poll site owns the side
 * effects (telemetry, usage attribution) and delegates the SHAPING here, alongside the terminal
 * normalisation this file already owns.
 */
export function buildRunningUpdate(
  view: RunnerJobView,
  followUps: { followUps?: StreamedFollowUp[] },
): Extract<AgentJobUpdate, { state: 'running' }> {
  const containerMeta = {
    ...(view.phase ? { phase: view.phase } : {}),
    ...(view.container ? { container: view.container } : {}),
    ...(view.backend ? { backend: view.backend } : {}),
    ...(view.heartbeatAt ? { lastActivityAt: view.heartbeatAt } : {}),
    // A published validation attempt is FINAL; the harness republishes a NEW attempt rather
    // than mutating the last one, so forwarding the latest on every poll is safe.
    ...(view.validationReport ? { validationReport: view.validationReport } : {}),
    // Likewise for the reproduction proof: a published attempt is FINAL and the harness
    // republishes a whole NEW one (with a fresh `at`) per repair round, so forwarding the latest
    // on every poll is safe — and is what makes a failed verification visible while the loop runs.
    ...(view.reproductionReport ? { reproductionReport: view.reproductionReport } : {}),
    // The per-slice reviews of a parallel review, forwarded latest-wins for the same reason — but
    // load-bearing rather than merely observable: this is the ONLY path by which a review's
    // finished slices become durable BEFORE its aggregation pass returns, so a poll that drops
    // them costs real review work. The harness republishes the whole set on each slice.
    ...(view.sliceReviews ? { sliceReviews: view.sliceReviews } : {}),
    // The CLI's own startup report on the tool servers this dispatch wired. Republished whole by
    // the harness on every poll rather than drained, so forwarding the latest is safe and no
    // single dropped poll response can be the one that loses it — which matters here more than
    // for the reports above, since the CLI announces its servers exactly once.
    ...(view.toolServers ? { toolServers: view.toolServers } : {}),
  }
  return view.progress
    ? { state: 'running', subtasks: view.progress, ...followUps, ...containerMeta }
    : { state: 'running', ...followUps, ...containerMeta }
}

/**
 * Map a settled-and-successful runner view into the engine's `done` {@link AgentJobUpdate}: the
 * normalised run result, any final burst of streamed follow-ups the harness drained on this same
 * poll, and the agent CLI's tool-server startup report.
 *
 * That last one rides the SETTLED poll and not only the running ones, which is not redundancy: a
 * job short enough to finish between two polls is never observed `running` at all, so for exactly
 * the runs that were quick about it this is the only poll that can carry the report. Pure, like
 * its `running` and `failed` siblings here — the executor's poll site owns the side effects and
 * delegates the shaping.
 */
export function buildDoneUpdate(
  view: RunnerJobView,
  result: AgentRunResult,
  followUps: { followUps?: StreamedFollowUp[] },
): Extract<AgentJobUpdate, { state: 'done' }> {
  return {
    state: 'done',
    result,
    ...followUps,
    ...(view.toolServers ? { toolServers: view.toolServers } : {}),
  }
}

/**
 * The structured failure metadata a terminal runner view carries, forwarded so the engine
 * classifies a failure without regex-matching `error`: the harness's `failureCause`, its
 * extended redacted `detail`, the serving `backend`, the transport's container-eviction verdict
 * (which the driver recovers on its own budget), and the two pre-PR verification reports — the
 * validation one, which for a job that failed because its checks stayed red until the attempt
 * budget was spent is the EVIDENCE behind the failure, and the reproduction proof, which a job
 * that died for an unrelated reason after the proof ran still legitimately carries. Each is read
 * off the terminal result first (authoritative) and falls back to the view's last live publish,
 * so a transport that forwards no terminal body still surfaces it. Every field is absent on an
 * older harness image.
 */
export function buildFailureMeta(view: RunnerJobView): {
  failureCause?: HarnessFailureCause
  detail?: string
  backend?: string
  evicted?: ContainerEvictionKind
  validationReport?: unknown
  reproductionReport?: unknown
  toolServers?: unknown
} {
  const validationReport = view.result?.validationReport ?? view.validationReport
  // A job that died for an UNRELATED reason after the proof ran still has a verdict worth keeping
  // — a failed verification never fails a job by itself, so a report present here describes work
  // that genuinely happened. Read terminal-first, view-fallback, exactly like the validation one.
  const reproductionReport = view.result?.reproductionReport ?? view.reproductionReport
  return {
    ...(view.failureCause ? { failureCause: view.failureCause } : {}),
    ...(view.detail ? { detail: view.detail } : {}),
    ...(view.backend ? { backend: view.backend } : {}),
    ...(view.evicted ? { evicted: view.evicted } : {}),
    ...(validationReport ? { validationReport } : {}),
    ...(reproductionReport ? { reproductionReport } : {}),
    // Read off the VIEW alone, unlike the two reports above: the observation is a fact about the
    // CLI's startup rather than about the work, so the harness publishes it on the view and never
    // on the terminal result. A failed run is the one that most needs it — a prompt that promised
    // tools the CLI never started is a prime suspect for whatever went wrong.
    ...(view.toolServers ? { toolServers: view.toolServers } : {}),
  }
}

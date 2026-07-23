import type { AgentRunResult, RunnerJobResult } from '@cat-factory/kernel'
import { INITIATIVE_PLANNER_AGENT_KIND } from '@cat-factory/kernel'
import {
  BLUEPRINTS_AGENT_KIND,
  coerceBlueprintService,
  coerceInitiativePlan,
  coerceSpecDoc,
  SPEC_WRITER_AGENT_KIND,
} from '@cat-factory/agents'
import {
  MERGER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  TESTER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
} from '@cat-factory/orchestration'

/**
 * Runner-output → engine-result normalisation for {@link ContainerAgentExecutor}.
 *
 * Extracted verbatim from `ContainerAgentExecutor.ts` (no behaviour change): these are the
 * pure functions that turn a finished {@link RunnerJobResult} into the engine's
 * {@link AgentRunResult}, including the kind-aware coercions (blueprint / spec / merge /
 * on-call / test) that used to live in the bespoke harness handlers. The output boundary
 * of the executor, kept as a self-contained, independently-testable unit.
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
export function toRunResult(result: RunnerJobResult, agentKind?: string): AgentRunResult {
  const mapped =
    result.custom !== undefined ? coerceCustomResult(result, agentKind) : mapPushOrPrResult(result)
  return result.effortReport ? { ...mapped, effortReport: result.effortReport } : mapped
}

/**
 * Coerce a structured `agent` job's parsed `custom` JSON into the engine's {@link AgentRunResult},
 * KIND-AWARE — the conservative coercion that used to live in the bespoke harness handlers
 * (blueprint/spec/merge/on-call/test) now runs backend-side, so the engine's resolvers/gates see
 * `blueprintService`/`spec`/`mergeAssessment`/`onCallAssessment`/`testReport` exactly as before.
 * Any other kind (a registered custom kind) surfaces the raw JSON as `custom` for its post-op to
 * coerce/render from. Called only when `result.custom !== undefined`.
 */
function coerceCustomResult(
  result: RunnerJobResult,
  agentKind: string | undefined,
): AgentRunResult {
  // Blueprinter: coerce into `blueprintService` (board reconcile + `blueprintPostOp`
  // render/commit). A nameless/garbage tree coerces to null ⇒ left unset.
  if (agentKind === BLUEPRINTS_AGENT_KIND) {
    const service = coerceBlueprintService(result.custom, '')
    return {
      output: result.summary?.trim() || 'Service blueprint updated.',
      ...(service ? { blueprintService: service } : {}),
    }
  }
  // Spec-writer: coerce into `spec` (engine strict-validate + `specPostOp` shard/commit).
  // The doc must carry its OWN `service` name (no repo-name rescue — backwards-compat is a
  // non-goal); a nameless/garbage doc coerces to null ⇒ left unset (no ingest, no commit).
  if (agentKind === SPEC_WRITER_AGENT_KIND) {
    // A purely TECHNICAL task has no business requirements to specify: the writer signals
    // `noBusinessSpecs` and we leave the baseline spec untouched (NO `spec` channel, so
    // `specPostOp` commits nothing). The engine reads the flag to infer the block's
    // `technical` label (with the spec-companion's corroboration). Checked first so a
    // model that returned both the flag and a stray baseline echo never commits over it.
    const custom = result.custom as Record<string, unknown> | null
    if (custom && typeof custom === 'object' && custom.noBusinessSpecs === true) {
      return {
        output:
          result.summary?.trim() ||
          'No business requirements to specify — this is a technical task.',
        noBusinessSpecs: true,
      }
    }
    const spec = coerceSpecDoc(result.custom, '')
    return {
      output: result.summary?.trim() || 'Service specification updated.',
      ...(spec ? { spec } : {}),
    }
  }
  // Initiative planner: coerce into `initiativePlan` (the engine's strict parse +
  // ingest into the `initiatives` entity). A structureless/garbage plan coerces to
  // null ⇒ left unset (no ingest — the step still records its prose output).
  if (agentKind === INITIATIVE_PLANNER_AGENT_KIND) {
    const plan = coerceInitiativePlan(result.custom)
    return {
      output: result.summary?.trim() || 'Initiative plan drafted.',
      ...(plan ? { initiativePlan: plan } : {}),
    }
  }
  if (agentKind === MERGER_AGENT_KIND) {
    return {
      output: result.summary?.trim() || 'Pull request assessed.',
      mergeAssessment: coerceMergeAssessment(result.custom, result.summary),
    }
  }
  if (agentKind === ON_CALL_AGENT_KIND) {
    return {
      output: result.summary?.trim() || 'Release regression investigated.',
      onCallAssessment: coerceOnCallAssessment(result.custom, result.summary),
    }
  }
  // Tester: coerce into `testReport` (greenlight-or-loop the fixer; the conservative
  // greenlight/blocking rule the harness `/test` handler applied now runs in
  // `coerceTestReport`, re-applied defensively by the TesterController).
  if (agentKind === TESTER_AGENT_KIND || agentKind === UI_TESTER_AGENT_KIND) {
    return {
      output: result.summary?.trim() || 'Testing complete.',
      testReport: coerceTestReport(result.custom, result.summary),
      // The in-container docker-compose stand-up record (local-infra tester) — forwarded so
      // the engine can persist its captured logs on the Tester step. Harness-produced, so
      // no coercion; the TesterController validates it defensively before persisting.
      ...(result.infraSetup ? { infraSetup: result.infraSetup } : {}),
    }
  }
  return {
    output: result.summary?.trim() || 'Agent run complete.',
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
 * Clamp a value to a 0..1 number, defaulting to `fallback` for anything that is not a
 * finite number (or a non-empty numeric string). Crucially, `null`, `''`, `false` and `[]`
 * fall back rather than coercing to `0` — `Number()` turns all of them into a finite `0`,
 * which would silently make a garbage merger score read as "trivial/safe" and defeat the
 * conservative-on-garbage default that replaces the harness's old `diffExaminable` guard.
 */
function clamp01(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** First non-empty of the agent's rationale or run summary (capped), else a stable default. */
function coerceRationale(rationale: unknown, summary: string | undefined): string {
  if (typeof rationale === 'string' && rationale.trim()) return rationale
  if (summary?.trim()) return summary.slice(0, 2000)
  return 'No rationale provided.'
}

/**
 * Coerce a migrated `merger` agent's structured JSON into the engine's merge assessment.
 * This is the conservative coercion the harness `/merge` handler used to do: a missing or
 * garbage score defaults to 1 (severe → routes to human review rather than a silent
 * auto-merge), and the rationale falls back to the agent's summary. The harness's extra
 * container-side `diffExaminable` guard (force 1/1/1 when the base diff was unreadable) is
 * not reproducible backend-side; the conservative-on-garbage default covers the same risk.
 */
function coerceMergeAssessment(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    complexity: clamp01(o.complexity, 1),
    risk: clamp01(o.risk, 1),
    impact: clamp01(o.impact, 1),
    rationale: coerceRationale(o.rationale, summary),
  }
}

/**
 * Coerce a migrated `on-call` agent's structured JSON into the engine's release-regression
 * assessment — the conservative coercion the harness `/on-call` handler used to do: a
 * missing confidence defaults to 0 (don't imply the PR is at fault without evidence) and a
 * missing recommendation defaults to `hold` (a human decides).
 */
function coerceOnCallAssessment(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : []
  return {
    culpritConfidence: clamp01(o.culpritConfidence, 0),
    recommendation:
      o.recommendation === 'revert' || o.recommendation === 'monitor' ? o.recommendation : 'hold',
    rationale: coerceRationale(o.rationale, summary),
    evidence,
  }
}

const TEST_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const TEST_STATUSES = new Set(['passed', 'failed', 'skipped'])

/**
 * Coerce a migrated `tester` agent's structured JSON into the engine's {@link TestReport} —
 * the conservative coercion the harness `/test` handler used to do, defaulting every field
 * safely so a malformed reply still parses (the engine strict-validates it). Crucially a
 * greenlight is honoured ONLY when no BLOCKING (high/critical) concern is open, so a model
 * that greenlights with an open blocker can't auto-pass; low/medium concerns are advisory.
 * The engine's TesterController re-applies this rule defensively.
 */
function coerceTestReport(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const outcomes = Array.isArray(o.outcomes)
    ? (o.outcomes as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          name: typeof x.name === 'string' ? x.name : '(unnamed)',
          status: TEST_STATUSES.has(x.status as string) ? (x.status as string) : 'skipped',
          ...(typeof x.detail === 'string' && x.detail ? { detail: x.detail } : {}),
        }))
    : []
  const concerns = Array.isArray(o.concerns)
    ? (o.concerns as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          title: typeof x.title === 'string' ? x.title : '(concern)',
          detail: typeof x.detail === 'string' ? x.detail : '',
          severity: TEST_SEVERITIES.has(x.severity as string) ? (x.severity as string) : 'medium',
        }))
    : []
  const blocking = concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
  const environment =
    o.environment === 'local' || o.environment === 'ephemeral' ? o.environment : undefined
  // The UI tester reports the screenshots it captured + uploaded (artifact ids); keep
  // only the well-formed entries (a view name + an artifact id), passing the optionals
  // through. Absent/empty for the API tester.
  const screenshots = Array.isArray(o.screenshots)
    ? (o.screenshots as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .filter((x) => typeof x.view === 'string' && typeof x.artifactId === 'string')
        .map((x) => ({
          view: x.view as string,
          artifactId: x.artifactId as string,
          ...(typeof x.hash === 'string' && x.hash ? { hash: x.hash } : {}),
          ...(typeof x.width === 'number' ? { width: x.width } : {}),
          ...(typeof x.height === 'number' ? { height: x.height } : {}),
          ...(typeof x.referenceArtifactId === 'string' && x.referenceArtifactId
            ? { referenceArtifactId: x.referenceArtifactId }
            : {}),
        }))
    : []
  // An abort signal: the Tester reported it can't run a meaningful test at all (its env never
  // came up, a dependency is missing). Carry the reason through and force the greenlight off —
  // an abort is never release-ready, and the engine routes it to a human instead of the fixer.
  // The presence of the `abort` object IS the signal: never let a blank/oversized `reason`
  // downgrade that intent back into a (pointless) fixer loop, so fall back to a generic reason
  // and cap it like `summary` (the reason is shown to the human + stored on the step verbatim).
  const abortRaw = (typeof o.abort === 'object' && o.abort !== null ? o.abort : null) as Record<
    string,
    unknown
  > | null
  const abortReason = abortRaw
    ? (typeof abortRaw.reason === 'string' && abortRaw.reason.trim()
        ? abortRaw.reason.trim()
        : 'the Tester could not run a meaningful test'
      ).slice(0, 2000)
    : undefined
  return {
    greenlight: o.greenlight === true && !blocking && !abortReason,
    summary:
      typeof o.summary === 'string' && o.summary ? o.summary : (summary?.slice(0, 2000) ?? ''),
    tested: Array.isArray(o.tested)
      ? (o.tested as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    outcomes,
    concerns,
    ...(environment ? { environment } : {}),
    ...(screenshots.length ? { screenshots } : {}),
    ...(abortReason ? { abort: { reason: abortReason } } : {}),
  }
}

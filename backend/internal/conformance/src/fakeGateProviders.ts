// Reusable, deterministic fake gate providers for the built-in `@cat-factory/gates` suite.
//
// The built-in gates (`ci`, `conflicts`, `post-release-health`, `doc-quality`) read their
// data source through a wired provider port; until one is wired the gate is a harmless
// pass-through. These factories build a provider whose verdict is supplied PER PROBE (a
// queue; the last entry repeats once exhausted), so a test can drive green / red→green,
// mergeable / conflicted→mergeable, healthy / regressed — the same shape the cross-runtime
// conformance suite already used inline. They are extracted here so BOTH the conformance
// suite AND the e2e testServer (which wires them per-workspace through `buildNodeContainer`'s
// `gateProviders` seam) reuse one implementation instead of copy-pasting it.
//
// Each factory closes over its own `i` counter, so a fresh call per workspace/test gives
// per-scope isolation for free (the e2e `E2eGateProviders` wrapper relies on exactly this).

import type {
  CiStatusProvider,
  DocQualityProvider,
  MergeabilityVerdict,
  PullRequestMergeabilityProvider,
  ReleaseHealthProvider,
  ReleaseHealthStatus,
  ReleaseSignal,
} from '@cat-factory/kernel'

/**
 * A single-repo fake CI provider whose per-probe verdict is supplied as a boolean queue
 * (`true` = green, `false` = red; the last entry repeats). `[false, true]` drives a red
 * build that goes green after the `ci-fixer` round.
 */
export function makeFakeCi(greens: boolean[]): CiStatusProvider {
  let i = 0
  return {
    getStatus: async () => {
      const green = greens[Math.min(i, greens.length - 1)] ?? true
      i += 1
      return {
        repos: [
          {
            repo: 'o/r',
            headSha: 'sha',
            checks: [
              {
                name: 'build',
                status: 'completed',
                conclusion: green ? 'success' : 'failure',
                url: null,
              },
            ],
          },
        ],
      }
    },
  }
}

/**
 * A single-repo fake mergeability provider whose per-probe verdict is supplied as a queue
 * (the last entry repeats). `['conflicted', 'mergeable']` drives a conflicted PR that merges
 * cleanly after the `conflict-resolver` round.
 */
export function makeFakeMergeability(
  verdicts: MergeabilityVerdict[],
): PullRequestMergeabilityProvider {
  let i = 0
  return {
    getMergeability: async () => {
      const verdict = verdicts[Math.min(i, verdicts.length - 1)] ?? 'mergeable'
      i += 1
      return { repos: [{ repo: 'o/r', headSha: 'sha', verdict }] }
    },
  }
}

/**
 * A fake release-health provider whose per-probe status is supplied as a queue (the last
 * entry repeats). A non-`healthy` status carries ONE alerting monitor signal — the gate
 * short-circuits to `pass` when `signals` is empty, and `describeRegressedSignals` only
 * names signals in the `alert` state, so a `regressed` status must emit an `alert` signal
 * to escalate the on-call agent. `['regressed']` drives a regression on the first probe.
 */
export function makeFakeReleaseHealth(statuses: ReleaseHealthStatus[]): ReleaseHealthProvider {
  let i = 0
  const signalFor = (status: ReleaseHealthStatus): ReleaseSignal[] =>
    status === 'healthy'
      ? [{ kind: 'monitor', id: 'mon_1', name: 'error-rate', state: 'ok' }]
      : [
          {
            kind: 'monitor',
            id: 'mon_1',
            name: 'error-rate',
            state: status === 'regressed' ? 'alert' : 'no_data',
            detail: status === 'regressed' ? '5.2% > 1% threshold' : undefined,
          },
        ]
  return {
    probe: async () => {
      const status = statuses[Math.min(i, statuses.length - 1)] ?? 'healthy'
      i += 1
      return { status, signals: signalFor(status) }
    },
    gatherEvidence: async () => ({
      regressedSignals: signalFor('regressed'),
      errors: [{ title: 'HTTP 500s on /login', count: 12, sampleMessage: 'fake: 500 Internal' }],
      notes: 'fake evidence bundle',
    }),
  }
}

/**
 * A fake doc-quality provider whose per-probe verdict is supplied as a boolean queue (the
 * last entry repeats). `[false, true]` drives a malformed document that passes after the
 * `doc-fixer` round.
 */
export function makeFakeDocQuality(oks: boolean[]): DocQualityProvider {
  let i = 0
  return {
    check: async () => {
      const ok = oks[Math.min(i, oks.length - 1)] ?? true
      i += 1
      return ok
        ? { ok: true, headSha: 'sha', path: 'docs/prd/x.md', findings: [] }
        : {
            ok: false,
            headSha: 'sha',
            path: 'docs/prd/x.md',
            findings: ['Missing required section: "Success Metrics".'],
          }
    },
  }
}

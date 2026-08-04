#!/usr/bin/env node
// Soft max-lines budget for non-test source files — the re-accretion guard the July 2026
// code-quality review asked for (docs/code-quality-observability-extensibility-review-2026-07.md
// §4/#5). The engine god-files have been split repeatedly (ExecutionService → RunDispatcher →
// RunAdmission / DeployerStepController / FollowUpGateController / review-kinds), and each time
// the recorded line counts drifted stale while the files silently regrew (RunDispatcher
// 2,779 → 4,217 between audits). This check turns that regrowth into a CI failure instead of a
// biennial audit finding.
//
// Policy:
//   - Every non-test `.ts`/`.vue` source file under the scanned roots must stay at or under
//     DEFAULT_MAX_LINES.
//   - Files that already exceeded it when this guard landed are RATCHETED in
//     LEGACY_ALLOWANCES at (roughly) their then-current size: they may shrink freely but may
//     not grow past their allowance. When you shrink one substantially, lower its allowance in
//     the same PR so the win is locked in; when a file drops under DEFAULT_MAX_LINES, delete
//     its entry.
//   - Genuinely needing to raise an allowance (or add one for a new file) is possible but
//     deliberate: edit this file in the same PR, so the growth is visible in review instead of
//     silent. Prefer extracting a collaborator (the RunDispatcher controllers are the model).
//
// How this relates to oxlint's `max-lines`, now that the ratchet has landed them on one number:
//   - The DEFAULT is READ FROM `.oxlintrc.json` rather than restated here, so the two guards
//     cannot drift apart. Lowering the rule tightens this guard in the same commit.
//   - oxlint is therefore the HARD ceiling and this guard is the per-file RATCHET on top of it.
//     An allowance ABOVE the ceiling is unreachable (oxlint fails the file first), so declaring
//     one is refused below rather than left to fail confusingly in the other guard.
//   - The two do NOT cover the same files: this guard skips test paths (see `isTestPath`),
//     oxlint's `max-lines` does not. `.oxlintrc.json`'s `overrides` block relaxes only
//     `max-lines-per-function` for tests, so a TEST file's sole size ceiling is the oxlint one.
//
// Usage:  node scripts/check-file-size.mjs
// Exit 0 = every file is within budget; exit 1 = a file exceeds it (or a legacy entry is stale).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The soft per-file budget, read from oxlint's `max-lines` rule so ONE number governs both size
 * guards. A missing or malformed rule THROWS rather than falling back to a literal: a silent
 * fallback is precisely the drift this read exists to prevent, and a guard that quietly grades
 * against a stale number reads exactly like one that passed.
 */
const DEFAULT_MAX_LINES = readOxlintMaxLines()

function readOxlintMaxLines() {
  const configPath = join(repoRoot, '.oxlintrc.json')
  const rule = JSON.parse(readFileSync(configPath, 'utf8'))?.rules?.['max-lines']
  const max = Array.isArray(rule) ? rule[1]?.max : undefined
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    throw new Error(
      `.oxlintrc.json: expected rules['max-lines'] to be ["error", { "max": <positive integer> }], ` +
        `got ${JSON.stringify(rule)}. This guard derives its default budget from that rule; ` +
        `fix the rule rather than hard-coding a number here.`,
    )
  }
  return max
}

/**
 * Ratcheted ceilings for the files that predate this guard (their size when it landed,
 * rounded up to the next 50). Shrink-only: lower these as files are split; never raise one
 * without a deliberate, reviewed reason.
 */
const LEGACY_ALLOWANCES = new Map([
  // The cross-runtime conformance suite (review §4), split from one 11.2k-line `suite.ts`
  // into per-group modules under `suites/`. `suite.ts` is now a thin aggregator; each group
  // keeps ratcheting DOWN as it sub-splits. `core.ts` has since been split into
  // `core-{workspaces,runs,planning,workspace-features}.ts` (a thin aggregator now), and
  // `agents.ts` dropped under DEFAULT_MAX_LINES — so, alongside `integration.ts` and
  // `execution.ts`, none of the conformance suites needs a ratcheted allowance any more.
  //
  // The engine files the 2026-07 review names (post-split sizes; keep ratcheting DOWN). The
  // dispatcher's three built-in registries (step handlers / completion interceptors / resolvers)
  // now live in `dispatcher-registries.ts`, so `RunDispatcher.ts` ratchets down accordingly.
  // The poll paths' "fold one update onto the step" helpers now live in `step-fold.logic.ts`,
  // so `RunDispatcher.ts` ratchets down accordingly.
  // The `max-lines` step-1 slice then took two more cohesive collaborators out of it: the RUNNING
  // half of the poll branch tree (`PollRunningController.ts`, the sibling of the settled-poll
  // `PollCompletionController`) and the one-shot engine steps tracker / bug-intake /
  // initiative-committer (`OneShotStepController.ts`) — ratcheted 2430 -> 1900.
  // (The `max-lines` step-2 slice then split out the DISPATCH side of a step
  // (`AgentDispatchController.ts`, the other side of the park from the two poll controllers) and
  // shed the deps declaration block to `RunDispatcherDependencies.ts`, so it fits the DEFAULT
  // budget (which oxlint's `max-lines` now enforces at the same number), so its allowance is gone.)
  // `ExecutionService.ts` shed its ~350-line `ExecutionServiceDependencies` declaration block to
  // its own module (re-exported, so no call site changed) when the PR-verification-report hook
  // needed headroom — ratcheted DOWN to lock the win in.
  // Then the two post-merge board follow-ups (`autoStartDependents` + `applyModuleAssignment`)
  // moved to `PostMergeBoardController.ts` when the logging conversion pushed the file over —
  // ratcheted DOWN again. They run AFTER the merge, read the board rather than execution state,
  // and are best-effort, which is what separated them from the run state machine.
  // Then the HUMAN decision surface (resolve / approve / request-changes / reject / merge, plus
  // the human-review fix request and the gate guard they share) moved to
  // `StepDecisionController.ts` for the `max-lines` step-1 slice — ratcheted 2300 -> 2000.
  // The two run-start funnels (the atomic live-run claim + the durable/SPA/outbound hand-off) then
  // moved to `runStart.ts` when the run-lifecycle push needed the hand-off documented — the budget
  // stays where the slice above put it, since that one had already left headroom. What separates
  // them is that `start`/`retry`/`restartFrom` differ ONLY in the block patch they write between
  // the two, so the ORDER across them is the thing worth owning in one place rather than three.
  // The `max-lines` step-2 slice then took that observation to its conclusion: `start` joined
  // `retry`/`restartFrom` (plus `resumePaused`/`cancel`/`stopRun`/`teardownForBlockTree`) on
  // `RunLifecycleController`, and the iteration-cap resolution both rework gates park for on
  // `IterationCapController`. The engine keeps the per-step machine and now fits the DEFAULT
  // budget (which oxlint's `max-lines` now enforces at the same number), so its allowance is gone.
  // The three DI composition roots (refactoring-candidates.md #6/#8 own the structural fix).
  // The orchestration root's optional-module factories now live in `container/modules.ts` and its
  // optional wiring flows through `container/module-registry.ts` (refactoring-candidates.md #6), so
  // `container.ts` holds the `CoreDependencies`/`Core` contract + the spine assembly only. The small
  // optional-module SHAPES then moved to `container/module-shapes.ts`, so it ratchets down again.
  // The Node root's container-agent-executor wiring now lives in `container-executor-deps.ts`, and
  // the Worker root's external LLM-trace destinations in `container-trace-sinks.ts` — both ratchet
  // down accordingly. The Node root then shed its ~350-line `NodeContainerOptions` declaration
  // block to `container-options.ts` (re-exported, so no call site changed — the same move
  // `ExecutionService.ts` made) and now fits the DEFAULT budget, so its allowance is gone.
  // `CoreDependencies` (the ~815-line `createCore` contract) now lives in `container/dependencies.ts`,
  // re-exported — the same split the engine's own dependency block got — so, on top of the
  // module-shapes extraction above, the domain composition root drops back under the DEFAULT
  // budget and needs no allowance at all.
  // The per-service store factories (`buildTestSecretsService` / `buildValidationConfigService`)
  // now live with the rest of that family in `wireCredentialServices.ts`, so the Worker
  // composition root ratchets down accordingly.
  // The `max-lines` step-1 slice then split three more modules out of the Worker root, mirroring
  // the Node facade's own file names: `container-model-resolver.ts` (the memoised inline model
  // provider + the per-step workspace default), `container-executor-deps.ts` (runner-transport
  // selection, the container executor, the composite + consensus wrap) and
  // `container-vcs-identity.ts` (the App registry + repo-target resolvers three sibling modules
  // already read off the root) — ratcheted 2300 -> 1650.
  // The `max-lines-per-function` 300 -> 250 step then took the deployment-wide credential /
  // telemetry / account-settings stores out to `container-shared-services.ts`, so `buildContainer`
  // is the ordering of its four phases and nothing else — ratcheted 1650 -> 1500.
  // The binary-artifact storage pair (`cloudflareContentStorage` + its resolver — already
  // standalone, because the retention cron needs them outside the container) then moved to
  // `container-artifact-storage.ts` — ratcheted 1500 -> 1470.
  // The facade's whole NOTIFICATION DELIVERY wiring (the Slack transport, the outbound
  // notification-webhook feature, and the composition of everything that is not the in-app push)
  // then moved to `container-notification-deps.ts` — ratcheted 1470 -> 1345. That extraction
  // SUPERSEDED this branch's narrower one (`container-notification-webhook.ts`, which moved only
  // the webhook builder): both hoisted the same builder out, so the file was deleted rather than
  // kept beside its replacement, and the platform-alert error hook moved onto the surviving one.
  ['backend/runtimes/cloudflare/src/infrastructure/container.ts', 1345],
  // Wide-but-flat declaration files (schemas / wire contracts), not control flow.
  // (`entities.ts` was split — the run/execution runtime-state shapes moved to `execution.ts`,
  // both now under DEFAULT_MAX_LINES — so it no longer needs a ratcheted allowance.)
  // The opt-in integration tables (sealed connections + per-service-frame integration config)
  // now live in `schema-integrations.ts`, re-exported from `schema.ts`. Combined with main's own
  // trimming the file is down to ~2130, so the allowance ratchets to the tighter of the two
  // in-flight values and then some.
  // The tenancy & identity tables (the `workspaces`/`users` roots, login identities, the account +
  // membership graph, invitations / password resets and the per-account rows) then moved to
  // `db/tables/identity.ts`, re-exported — ratcheted 2150 -> 1900.
  // The SETTINGS rows (the local-mode singleton, the per-user budget, the per-workspace runtime
  // policy row and the per-agent-kind generation knob) then moved to `db/tables/settings.ts` the
  // same way — ratcheted 1900 -> 1820.
  // The PROMPT-FRAGMENT LIBRARY rows (the tenant-scoped best-practice catalog, its generated
  // condensed briefs, its repo sources and the per-workspace inherited selection) then moved to
  // `db/tables/prompt-fragments.ts` the same way — ratcheted 1820 -> 1716.
  // The SLACK tables (connection + routing + member map — one integration, referencing nothing
  // else) moved to `db/schema-slack.ts` when `agent_runs` gained its re-drive counter — ratcheted
  // 1716 -> 1700.
  // The OBSERVABILITY group (the `telemetry` Postgres schema and its three append-heavy sinks,
  // plus the two deployment-level projections the operator dashboard aggregates) moved to
  // `db/tables/observability.ts` when the gate + daily-rollup projections landed, ratcheted
  // 1700 -> 1600.
  // The OUTBOUND MODEL-PROVIDER CREDENTIAL group (the pooled subscription tokens, the
  // direct-provider keys, the personal subscriptions + per-run activations, the per-user local
  // endpoints, the gateway-model catalog and the quota-cycle windows they accumulate into) then
  // moved to `db/tables/model-credentials.ts` the same way, so the schema fits the DEFAULT budget
  // (which oxlint's `max-lines` now enforces at the same number), and its allowance is gone.
  // Remaining oversized service/logic files — split candidates, ratcheted meanwhile.
  // (`EnvironmentConnectionService.ts` has since dropped under DEFAULT_MAX_LINES — entry removed.)
  // The Kubernetes half of the detector (what counts as a cluster manifest, the manifest-tree scan
  // and the facts inferred back off it) now lives in `provision-detect.kubernetes.ts`, over the
  // YAML/loose-value primitives both halves share in `provision-detect.yaml.ts` — ratcheted
  // 2250 -> 1850.
  // (The COMPOSE / stack-recipe half then moved to `provision-detect.compose.ts` over the shared
  // detector contract in `provision-detect.contract.ts`, leaving the Kubernetes half plus the two
  // entry points; it fits the DEFAULT budget now, so this allowance is gone too.)
  // The repo-targeting declaration block (RepoTarget/ResolveRepoTarget/RepoOrigin/…) moved to
  // `agents/repoTargeting.ts`, and the poll site's pure runner-view → engine-update shaping
  // (`buildRunningUpdate` / `buildFailureMeta`) now lives with the rest of the output-boundary
  // normalisation in `containerAgentResult.ts` — so the executor ratchets down on both counts.
  // Ratcheted 1520 → 1450 by extracting `agentContextRecord.ts` (the observability snapshot's
  // allow-list projection) alongside `containerAgentLogging.ts`.
  ['backend/packages/server/src/agents/ContainerAgentExecutor.ts', 1444],
  // The two `/search/*` endpoints (issue + code search) and their response shapes moved to
  // `github/searchApi.ts` when the bug hunt needed the issue search to surface the extra
  // fields its response already carries — so the client ratchets DOWN.
  // Ratcheted 1500 → 1455 by extracting `github/reviewThreads.ts` (the GraphQL review-thread
  // reads/writes, the sibling of `reviewPosting.ts`'s REST half) and folding the single-PR
  // accessors onto one `readPullRequest` when `getPullRequest` joined them.
  // Ratcheted 1455 → 1375 when the branch-protection preflight needed a new port method. Three
  // things came out, each a concern that is NOT "authenticate as an installation and account for
  // its rate limit": the two protection READS (`github/branchProtection.ts` — the preflight probe
  // and the required-approvals lookup hit the same resource and must not learn failure modes
  // separately), the CALLER-TOKEN repo reads behind the personal-PAT picker
  // (`github/viewerTokenReads.ts`, which mints, caches and records nothing), and `GitHubApiError`
  // plus the shared request constants (`githubHttpHelpers.ts` — several modules now classify off
  // the error, and both callers must send the same headers).
  ['backend/packages/server/src/github/FetchGitHubClient.ts', 1356],
])

/**
 * Ratcheted ceilings for PROSE files with a documented tendency to regrow. CLAUDE.md's own
 * charter says flow-specific detail belongs in each flow's doc, and the file still regrew from
 * ~700 to ~1,850 lines between hand audits; this entry turns that regrowth into a CI failure.
 * Shrink-only, like LEGACY_ALLOWANCES: move detail into the linked authority doc rather than
 * raising the number, and lower the allowance in the same PR when a cleanup lands a win.
 */
const DOC_ALLOWANCES = new Map([['CLAUDE.md', 1100]])

/** Roots scanned for source files (mirrors the workspace layout; deploy/* are one-liners). */
// `sdk/**` is deliberately ABSENT. The ratchet is a split trigger for hand-written cohesion, and
// the largest files there are GENERATED (`models_gen.go` alone is past the default), where the
// remedy the guard exists to prompt — extract the concern your change touches — is not available:
// what gets emitted is decided by the emitters in `scripts/sdk/`, and the size of one output file
// says nothing about whether they are well factored. The SDK's hand-written halves are each well
// under budget; `scripts/check-sdks.mjs` is what guards that tree.
const SCAN_ROOTS = ['backend/packages', 'backend/runtimes', 'backend/internal', 'frontend/app']

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.nuxt', '.output', 'coverage'])

function isTestPath(rel) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(rel) ||
    /\.(test|spec)\.[cm]?ts$/.test(rel) ||
    /\.(test|spec)-d\.ts$/.test(rel)
  )
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    const abs = join(dirAbs, entry)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      yield* sourceFiles(abs)
    } else if (/\.([cm]?ts|vue)$/.test(entry) && !entry.endsWith('.d.ts')) {
      yield abs
    }
  }
}

const failures = []
const seenLegacy = new Set()

// An allowance above oxlint's ceiling can never be reached: oxlint fails the file first, so the
// entry would grant headroom that does not exist while this guard reported success. Refuse it
// here, where the fix is, instead of leaving a contradiction for the other guard to report.
for (const [rel, allowance] of LEGACY_ALLOWANCES) {
  if (allowance > DEFAULT_MAX_LINES) {
    failures.push(
      `${rel}: allowance ${allowance} exceeds oxlint's max-lines ceiling of ${DEFAULT_MAX_LINES}, ` +
        'so it is unreachable (oxlint fails the file first). Split the file, or raise the ' +
        'ceiling in .oxlintrc.json first.',
    )
  }
}

for (const root of SCAN_ROOTS) {
  const rootAbs = join(repoRoot, root)
  for (const abs of sourceFiles(rootAbs)) {
    const rel = relative(repoRoot, abs).replaceAll('\\', '/')
    if (isTestPath(rel)) continue
    const lines = readFileSync(abs, 'utf8').split('\n').length
    const allowance = LEGACY_ALLOWANCES.get(rel)
    if (allowance !== undefined) seenLegacy.add(rel)
    const budget = allowance ?? DEFAULT_MAX_LINES
    if (lines > budget) {
      failures.push(
        `${rel}: ${lines} lines exceeds its budget of ${budget}` +
          (allowance !== undefined
            ? ' (a ratcheted legacy allowance — split the file instead of growing it)'
            : ` (the default max of ${DEFAULT_MAX_LINES} — extract a collaborator/module)`),
      )
    }
  }
}

// A legacy entry whose file no longer exists (renamed/deleted) is stale — fail so the
// allowance can't silently linger and be repurposed by a future file at the same path.
for (const rel of LEGACY_ALLOWANCES.keys()) {
  if (!seenLegacy.has(rel)) {
    failures.push(`${rel}: legacy allowance entry is stale (file not found) — remove it`)
  }
}

// Prose ratchet: same shrink-only contract as the source allowances above.
for (const [rel, allowance] of DOC_ALLOWANCES) {
  let lines
  try {
    lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n').length
  } catch {
    failures.push(`${rel}: doc allowance entry is stale (file not found); remove it`)
    continue
  }
  if (lines > allowance) {
    failures.push(
      `${rel}: ${lines} lines exceeds its budget of ${allowance} (a ratcheted doc allowance; ` +
        "move flow detail into the linked flow docs, per the file's own charter, instead of " +
        'growing it)',
    )
  }
}

if (failures.length > 0) {
  console.error('File-size budget check failed:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nSplit the file along a cohesive seam (see the RunDispatcher controller extractions),',
  )
  console.error('or — deliberately — adjust scripts/check-file-size.mjs in the same PR.')
  process.exit(1)
}

console.log('File-size budgets OK.')

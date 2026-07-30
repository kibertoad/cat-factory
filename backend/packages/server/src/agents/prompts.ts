import { type AgentRunContext, hostMarkdown } from '@cat-factory/kernel'
import { type AgentKindRegistry, userPromptFor } from '@cat-factory/agents'
import {
  frameProfile,
  FRONTEND_WIREMOCK_PORT,
  resolveFrontendServePort,
} from '@cat-factory/contracts'
import type { RepoTarget } from './ContainerAgentExecutor.js'

/**
 * The role/system prompts, structured-output shape hints, and per-kind user-prompt
 * builders for the built-in container agent kinds the {@link ContainerAgentExecutor}
 * dispatches through the generic `agent` harness surface but that are NOT yet real
 * `registerAgentKind` entries (merger / on-call / tester). Extracted verbatim from
 * `ContainerAgentExecutor.ts` so the prompt material lives in one cohesive unit; the
 * executor imports it at its original call sites. Pure strings + pure builder functions —
 * no executor state. (The migrated `blueprints` / `spec-writer` prompts now live with their
 * definitions in `@cat-factory/agents` — `agents/kinds/spec-blueprints.ts`.)
 */

// The two bespoke container prompts (`merger`, `on-call`) now live in `@cat-factory/agents`
// (`agents/prompts/bespoke-kinds.ts`) beside the inline-engine ones, because the ENGINE needs
// the same answer they encode — a variant's alternate prompt is resolved against the SHIPPED
// base once per dispatch, and for these two kinds that base is the ROLE half. Import them from
// `@cat-factory/agents` directly; this layer reads them through the bespoke-prompt map that
// ./promptOverrides.ts composes.

/** Compact shape hint fed to the structured-output repair call for the merger assessment. */
export const MERGE_ASSESSMENT_SHAPE_HINT =
  'Expected a merge assessment: {"complexity": number 0..1, "risk": number 0..1, ' +
  '"impact": number 0..1, "rationale": string}.'

/** Compact shape hint fed to the structured-output repair call for the on-call assessment. */
export const ON_CALL_ASSESSMENT_SHAPE_HINT =
  'Expected an on-call assessment: {"culpritConfidence": number 0..1, "recommendation": ' +
  '"revert"|"hold"|"monitor", "rationale": string, "evidence": string[]}.'

/** Compact shape hint fed to the structured-output repair call for the tester report. */
export const TEST_REPORT_SHAPE_HINT =
  'Expected a test report: {"greenlight": boolean, "summary": string, "tested": string[], ' +
  '"outcomes": [{"name": string, "status": "passed"|"failed"|"skipped", "detail"?: string}], ' +
  '"concerns": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"|"critical"}]}.'

/** Shape hint for the UI tester: a test report that also lists captured screenshots. */
export const UI_TEST_REPORT_SHAPE_HINT =
  TEST_REPORT_SHAPE_HINT.replace(/\}\.$/, '') +
  ', "screenshots": [{"view": string, "artifactId": string, "hash"?: string}]}. Each ' +
  'screenshot must be a distinct view you captured and uploaded to the artifact store.'

/**
 * The merger's task prompt — the instructions + diff guidance the bespoke harness `/merge`
 * handler used to build. Kept backend-side now that the merger dispatches the generic
 * explore agent. Names the PR/branches so the agent diffs against the right base.
 */
export function mergerUserPrompt(context: AgentRunContext, repo: RepoTarget): string {
  const prNumber = context.block.pullRequest?.number
  const branch = context.block.pullRequest?.branch ?? repo.baseBranch
  const pr = prNumber !== undefined ? ` (PR #${prNumber})` : ''
  return [
    'Assess the pull request on the head branch against the base branch and return the ' +
      'complexity / risk / impact scores + rationale as JSON.',
    '',
    `The pull request${pr} is on branch \`${branch}\`; the base branch is ` +
      `\`${repo.baseBranch}\`. Inspect the change (e.g. \`git fetch origin ${repo.baseBranch}\` ` +
      `then \`git diff origin/${repo.baseBranch}...HEAD\`) and score complexity, risk and impact.`,
    '',
    'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.',
  ].join('\n')
}

/**
 * The merger's task prompt for a MULTI-REPO task (service-connections phase 4): the change is one
 * PR per repo, each checked out as a read-only sibling on its PR branch. The exact per-repo diff
 * commands + sibling directories live in the "Multi-repo pull request" system-prompt section
 * (rendered by `renderMergerMultiRepoSection`), so this prompt just tells the agent to run them and
 * score the COMBINED cross-repo change as ONE assessment.
 */
export function mergerMultiRepoUserPrompt(context: AgentRunContext): string {
  return [
    'This pull request spans MULTIPLE repositories — see the "Multi-repo pull request" section in ' +
      'your instructions for each repository, its sibling directory, and the diff command to run.',
    '',
    'Run every per-repo diff, then assess the COMBINED change as one unit: its overall complexity, ' +
      'the risk of the coordinated cross-repo change, and its combined blast radius. Return a SINGLE ' +
      'assessment covering all repositories (not one per repo).',
    '',
    `Task: ${context.block.title}`,
    '',
    'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.',
  ].join('\n')
}

/**
 * The on-call agent's task prompt — the regression evidence (the generic block/prior-output
 * prompt) plus the locate-the-merged-commit guidance the bespoke harness `/on-call` handler
 * used to build. The released PR already merged into the base branch (its work branch is
 * gone), so the agent is on the base branch and is told how to find the merged commit.
 */
export function onCallUserPrompt(
  context: AgentRunContext,
  repo: RepoTarget,
  registry: AgentKindRegistry,
): string {
  const prNumber = context.block.pullRequest?.number
  const headBranch = context.block.pullRequest?.branch
  const pr = prNumber !== undefined ? `#${prNumber}` : ''
  const locate = prNumber
    ? `It merged as a commit referencing ${pr} — find it with \`git log --oneline -n 50\` ` +
      `(squash/merge commits include \`(${pr})\`; a merge commit mentions \`#${prNumber}\`), then ` +
      `inspect it with \`git show <sha>\`.`
    : headBranch
      ? `Its work branch was \`${headBranch}\` (now deleted) — find the merged commit in ` +
        `\`git log --oneline -n 50\` and inspect it with \`git show <sha>\`.`
      : `Find the most recent merge/feature commit with \`git log --oneline -n 50\` and inspect ` +
        `it with \`git show <sha>\`.`
  return [
    userPromptFor(context, registry, { materialized: true }),
    '',
    `You are on the base branch \`${repo.baseBranch}\`, which already contains the released ` +
      `pull request ${pr}. ${locate} Correlate that change with the regression evidence above. ` +
      `Beware correlation vs causation.`,
    '',
    'Respond with ONLY a JSON object {"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…","evidence":["…"]}.',
  ].join('\n')
}

/**
 * The tester's infra stand-up spec for the generic agent job, derived from the frame's capability
 * profile + its declared provision type AND whether the run actually provisioned an environment: a
 * `library` frame (not `deployable`) runs its suite in-container, so it emits `local` + its
 * repo/package-local `composePath` (reviving the harness `standUpInfra` DinD path) when one is
 * declared, else `local` + `noInfraDependencies`; a `docker-compose`/`kubernetes`/`custom` service
 * — or ANY run that provisioned an env URL (e.g. a `deployer` step) — runs against that ephemeral
 * environment (`environment:'ephemeral'` + the URL when present), since all three are stood up by
 * the single Deployer step; an `infraless` service (or none declared) stands nothing up (`local` +
 * `noInfraDependencies`). The harness `infra` wire shape is unchanged. Kept in lock-step with
 * {@link testerEnvironmentSection} (agents) so the prompt and the harness `infra` spec never disagree.
 */

/**
 * Env-var names never injected from a frontend binding: they are spread over `process.env` at
 * build time in the container, so a binding named `PATH` / `NODE_OPTIONS` / … would clobber the
 * toolchain (or enable code execution / cert overrides) rather than name an upstream URL. The
 * harness re-filters these on the way in (defence in depth); we also drop them here so a reserved
 * name never leaves the backend as an injected env var. Matched exactly (Linux env is
 * case-sensitive); {@link RESERVED_ENV_PREFIXES} covers whole families (`npm_config_*`, `GIT_*`).
 * Kept in sync with the harness's own list in `executor-harness/src/job.ts`.
 */
const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
])

/**
 * Env-var name prefixes never injected (reconfigure the package manager / git during the build).
 * Compared case-INSENSITIVELY (lower-cased): npm reads its config env with a case-insensitive
 * `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY` is honoured exactly like `npm_config_registry` — a
 * case-sensitive match would let the upper-cased form through. Kept in sync with the harness list.
 */
const RESERVED_ENV_PREFIXES = ['npm_config_', 'git_']

/**
 * Whether an env-var name is reserved (an exact canonical name, matched verbatim, or a reserved
 * family prefix, matched case-insensitively — see {@link RESERVED_ENV_PREFIXES}).
 */
function isReservedEnvName(key: string): boolean {
  if (RESERVED_ENV_NAMES.has(key)) return true
  const lower = key.toLowerCase()
  return RESERVED_ENV_PREFIXES.some((p) => lower.startsWith(p))
}

export function testerInfraSpec(context: AgentRunContext): Record<string, unknown> {
  // A `frontend` frame under the self-contained UI-test flow builds + serves the app and stands
  // WireMock up for its other upstreams — all as in-container processes (no DinD). The backend
  // has already resolved each binding to a concrete URL (the service-under-test's live ephemeral
  // env, or absent ⇒ mock); this turns that into the harness `frontend` infra spec.
  if (context.frontend) return buildFrontendInfraSpec(context.frontend)

  const provisioning = context.service?.provisioning
  const frameType = context.service?.type
  // A `library` frame runs the tester in `suite` posture: never deployed, no ephemeral env — it
  // runs its suite in-container. Stand up its repo/package-local test dependencies on localhost when
  // the frame declares a compose path — this REVIVES the harness `standUpInfra` DinD path (dormant
  // since compose started routing to `ephemeral`) — so `{ environment: 'local', composePath }`.
  // With no declared compose path the agent self-manages test deps via the repo's lifecycle
  // scripts (`pretest:ci`/…), so nothing is stood up (`noInfraDependencies`). Keyed off the
  // profile's `testPosture` so it stays in lock-step with the `testerEnvironmentSection` (agents)
  // prompt narration, which keys its run-mode off the same flag.
  if (frameType && frameProfile(frameType).testPosture === 'suite') {
    const composePath = provisioning?.composePath?.trim()
    return {
      environment: 'local',
      ...(composePath ? { composePath } : { noInfraDependencies: true }),
    }
  }
  const type = provisioning?.type
  const envUrl = context.environment?.url
  // The involved connected services with a LIVE ephemeral env this run (title → URL), so a
  // cross-service integration test can reach a peer's real environment. Keyed by title (the
  // human-facing service name the test refers to). Two involved services can share a title, so a
  // collision is disambiguated with the frame id rather than silently dropping a peer's URL.
  // Absent when no involved peer is live.
  const peerEnvironments: Record<string, string> = {}
  for (const involved of context.involvedServices ?? []) {
    if (!involved.envUrl) continue
    const key =
      peerEnvironments[involved.title] !== undefined
        ? `${involved.title} (${involved.frameId})`
        : involved.title
    peerEnvironments[key] = involved.envUrl
  }
  const peers = Object.keys(peerEnvironments).length ? { peerEnvironments } : {}
  // Prefer a provisioned environment whenever one exists. `docker-compose`/`kubernetes`/`custom`
  // are all stood up by the single `deployer` step (compose now goes through a workspace handler +
  // the recipe/shared-stack provider, exactly like the others), so the Tester targets that URL
  // rather than standing anything up itself. `infraless`/undeclared falls through to no-infra.
  if (type === 'docker-compose' || type === 'kubernetes' || type === 'custom' || envUrl) {
    return {
      environment: 'ephemeral',
      ...(envUrl ? { environmentUrl: envUrl } : {}),
      ...peers,
    }
  }
  return {
    environment: 'local',
    noInfraDependencies: true,
    ...peers,
  }
}

/**
 * The harness `frontend` infra spec for a self-contained UI test, from the frame's resolved
 * frontend context. Maps the config's build/serve/mock knobs onto the harness wire shape and
 * turns each resolved binding into an env var: the service-under-test's live ephemeral env URL
 * when one resolved, else the in-container WireMock URL (every OTHER upstream is mocked). The
 * bindings were already env-var-filtered upstream, so no empty var reaches the injected env.
 */
export function buildFrontendInfraSpec(
  frontend: NonNullable<AgentRunContext['frontend']>,
): Record<string, unknown> {
  const { config, bindings } = frontend
  const wiremockUrl = `http://localhost:${FRONTEND_WIREMOCK_PORT}`
  const env: Record<string, string> = {}
  for (const binding of bindings) {
    if (!binding.envVar || isReservedEnvName(binding.envVar)) continue
    env[binding.envVar] = binding.serviceUrl ?? wiremockUrl
  }
  return {
    kind: 'frontend',
    ...(config.directory ? { directory: config.directory } : {}),
    ...(config.packageManager ? { packageManager: config.packageManager } : {}),
    ...(config.installCommand ? { install: config.installCommand } : {}),
    ...(config.buildScript ? { buildScript: config.buildScript } : {}),
    ...(config.outputDir ? { outputDir: config.outputDir } : {}),
    ...(config.serveMode ? { serveMode: config.serveMode } : {}),
    ...(config.serveScript ? { serveScript: config.serveScript } : {}),
    servePort: resolveFrontendServePort(config.servePort),
    ...(config.envInjection ? { envInjection: config.envInjection } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(config.mockMappingsPath ? { wiremockMappingsPath: config.mockMappingsPath } : {}),
    wiremockPort: FRONTEND_WIREMOCK_PORT,
  }
}

/**
 * The dispatch-time FALLBACK pull-request description. Composed BEFORE the agent runs, so it can
 * only brief the reviewer on what the pipeline already knows: the task being solved and (when the
 * fork-decision phase ran) the implementation approach a human chose, with the rejected
 * alternatives. The agent is asked to replace it with its own briefing via the PR-description
 * sentinel (`PR_DESCRIPTION_GUIDANCE`); this text is what a PR gets when the agent wrote none.
 *
 * Every hole here is filled with text the platform did not write — a human's task description, a
 * human's free-text approach, and (for `alternativesConsidered`) the fork proposer MODEL's own
 * titles — landing on a host-parsed surface where `#123` links, `@name` pages a real account and
 * a closing keyword closes an issue on merge. So each crosses `hostMarkdown` on the way in, per
 * its own rule: a host-bound body takes `inline`, `cell` or `prose`, never a bare template hole.
 */
export function prBody(context: AgentRunContext): string {
  const lines = [
    `Automated implementation for **${hostMarkdown.inline(context.block.title)}** ` +
      `(${context.block.type}), delivered by the \`${context.pipelineName}\` pipeline.`,
    '',
    '## Task',
    '',
    context.block.description
      ? hostMarkdown.prose(context.block.description)
      : '_No task description was provided._',
  ]
  const choice = context.implementationChoice
  if (choice) {
    lines.push(
      '',
      '## Chosen implementation approach',
      '',
      `**${hostMarkdown.inline(choice.title)}**` +
        (choice.source === 'custom'
          ? ' (specified by a human reviewer)'
          : ' (picked by a human reviewer from the proposed forks)'),
      '',
      hostMarkdown.prose(choice.approach),
    )
    if (choice.alternativesConsidered.length) {
      const { items, dropped } = hostMarkdown.capList(choice.alternativesConsidered)
      const rendered = items.map((title) => hostMarkdown.inline(title)).join('; ')
      lines.push(
        '',
        `Alternatives considered and rejected: ${rendered}.` +
          (dropped ? ` (${dropped} further alternatives omitted.)` : ''),
      )
    }
    if (choice.note) {
      lines.push('', `Reviewer note on the choice: ${hostMarkdown.inline(choice.note)}`)
    }
  }
  lines.push(
    '',
    '---',
    '',
    '_This description was generated when the run was dispatched; the agent did not write ' +
      'its own reviewer briefing for this pull request._',
  )
  return lines.join('\n')
}

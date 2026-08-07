import { type AgentRunContext, hostMarkdown } from '@cat-factory/kernel'
import {
  frameProfile,
  FRONTEND_WIREMOCK_PORT,
  resolveFrontendServePort,
} from '@cat-factory/contracts'

/**
 * What the container dispatch layer still renders itself: the TESTER INFRA spec (derived per run
 * from the frame's capability profile and what the run provisioned) and the pull-request body.
 * Both are facts about this deployment's checkout and VCS, not about an agent's role.
 *
 * Every per-KIND prompt has moved out. The bespoke role prompts (`merger`, `on-call`) live in
 * `@cat-factory/agents` (`agents/prompts/bespoke-kinds.ts`) because the ENGINE resolves a
 * variant's alternate prompt against the shipped base; the task prompts and shape hints that used
 * to sit here moved beside those kinds' registrations (`agents/prompts/built-in-container.ts`)
 * when the built-ins became real `registerAgentKind` entries, since a registered kind's prompts
 * are resolved through `userPromptFor` and could not be reached from the HTTP layer.
 */

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

import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import { DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH } from '@cat-factory/contracts'
import { STANDARDS_FOOTER } from './shared.js'

// Built-out role prompt for the mock-builder agent. This kind stands up
// WireMock-based mocks for the external SERVICES a building block depends on, so
// the block can build, run and be tested locally and in CI without reaching real
// third parties — in particular so end-to-end / Playwright suites pass on GitHub
// Actions against the mocks rather than live APIs.
//
// Like the standard solution phases and the acceptance-testing track, "what the
// agent should do" lives here and "which extra standards apply" stays in
// @cat-factory/prompt-fragments: the prompt closes by deferring to the
// best-practice fragments that `composeSystemPrompt` appends below it. The
// dynamic run context (the block, its features, linked requirement docs and the
// prior agents' output — where the external dependencies surface) is folded in by
// the generic `userPromptFor`.

/** The single agent kind that builds external-dependency mocks. */
export const MOCK_AGENT_KIND = 'mocker'

const SYSTEM_PROMPT = [
  'You are an integration-test engineer owning the EXTERNAL-DEPENDENCY MOCKS for a building block.',
  'Your goal: make the service runnable and usable LOCALLY with just `docker-compose up` — every external service it depends on answered by a WireMock mock, so it builds, runs and can be exercised end to end without reaching any real third party. This is what lets the later Tester step actually run the service.',
  '',
  'This is a HANDS-ON build step, not a write-up. You MUST inspect the repository, then create/extend the mock mappings, fixtures and wiring and COMMIT them. Do NOT merely restate what the implementer did, describe the dependencies in prose, or report "already covered" without having read the existing mappings and confirmed it. If the block calls external services that are not yet mocked, leaving them unmocked is a failure of this step. A commit with the new/updated mock files is the deliverable; the prose note is only a summary of what you committed.',
  '',
  'Scope — services, not infrastructure:',
  '- Mock external SERVICES the block depends on: third-party / partner HTTP APIs, payment, email / SMS, auth or identity providers, and other internal services reached over the network.',
  '- Do NOT mock owned infrastructure (databases, caches, queues, object storage) — those run as real local instances (e.g. containers) wired into docker-compose, not WireMock.',
  '',
  'Be incremental and additive:',
  '- First discover what is already mocked: read the existing WireMock stub mappings, response fixtures and mock wiring already in the repository.',
  '- Inventory the external calls the block actually makes — base URL, path, method, auth headers, request and response shapes — from the code and the design / prior work given to you.',
  '- Add stubs ONLY for calls that are not mocked yet. Never duplicate, rewrite or delete an existing mapping; if an existing stub looks wrong, flag it rather than silently changing it.',
  '',
  'WireMock best practices:',
  '- Pin WireMock to the latest STABLE release: check what the newest stable (non-prerelease) `wiremock/wiremock` version is at the moment you set this up and pin the image / dependency to that exact tag — do not hard-code an older version and do not use a floating `latest` tag.',
  '- One stub mapping per external operation; match on method + URL path, adding header / query / body matchers only where they are needed to disambiguate — keep matchers as loose as correctness allows so they are not brittle.',
  '- Return realistic, schema-faithful response bodies and status codes; cover the success path plus the error and edge responses the block must handle (4xx, 5xx, rate limits, timeouts).',
  '- Keep mappings deterministic and self-contained: prefer JSON mapping files (with response bodies in `__files`) checked into the repo over programmatic stubs, and reach for response templating only where a dynamic echo is genuinely required.',
  '- Organise mappings per upstream service and name each one after the operation it stands in for, so coverage is easy to read.',
  '- Add a low-priority catch-all stub that fails loudly on any unmatched request, so a new, yet-unmocked call is caught instead of silently passing.',
  '- Never hard-code real secrets in stubs; assert on the presence / shape of auth headers, not their real values.',
  '',
  'Hook the mocks up for local docker-compose and CI runs:',
  "- Add the WireMock server to the service's docker-compose so a plain `docker-compose up` brings the mocks up alongside the real infra; point the block's external base URLs at it through environment variables / config, switched on for local dev and CI and off in production.",
  '- Make it runnable in CI (e.g. a GitHub Actions service container or a start step) so end-to-end / Playwright tests pass on GHA against the mocks, waiting on a health check before the tests start.',
  '- Document how to start the mocks and run the suite locally with the same configuration, so local and CI behave identically.',
  '',
  'Commit the WireMock mapping files, the response fixtures and the docker-compose / config / wiring changes. Then, as your prose output, list each external service and which of its operations are now mocked, and call out any external call you deliberately left unmocked and why.',
  '',
  STANDARDS_FOOTER,
].join('\n')

/** True when the agent kind is the mock-builder. */
export function isMockKind(kind: AgentKind): boolean {
  return kind === MOCK_AGENT_KIND
}

/**
 * The frontend-specific mocking guidance for a `mocker` run whose frame is a `type: 'frontend'`
 * app (the self-contained UI-test flow). A frontend's mocks are consumed very differently from a
 * backend service's: the platform serves the built app AND WireMock as in-container processes (no
 * docker-compose, no DinD), reading the stub mappings straight from a directory in the FRONTEND
 * repo. So the mocker must author WireMock mappings under that directory in WireMock's `--root-dir`
 * layout — NOT wire a docker-compose stack — for exactly the upstreams the harness will point at
 * WireMock (every binding whose backend is not a LIVE service under test). Returns `undefined` for
 * a backend run (or a non-mocker kind), so callers can append it unconditionally.
 *
 * Kept in lock-step with the harness `frontend` infra spec (server `testerInfraSpec` /
 * `buildFrontendInfraSpec`): the served app reads each upstream URL from an injected env var, and
 * a binding with no live service resolves to the in-container WireMock — those are the calls that
 * MUST be mocked here.
 */
export function mockFrontendSection(context: AgentRunContext): string | undefined {
  if (!isMockKind(context.agentKind) || !context.frontend) return undefined
  const { config, bindings } = context.frontend
  const root = config.mockMappingsPath?.trim() || DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH
  const dir = root.replace(/\/+$/, '')
  // The upstreams the harness will serve from WireMock: every resolved binding with no live
  // `serviceUrl` (a `mock` source, or a `service` whose ephemeral env isn't live). A binding WITH
  // a serviceUrl is the real service under test — do NOT mock it.
  const mocked = bindings.filter((b) => !b.serviceUrl).map((b) => b.envVar)
  const live = bindings.filter((b) => b.serviceUrl).map((b) => b.envVar)
  const lines = [
    '',
    'FRONTEND UI TEST — this block is a frontend app, so its mocks are consumed by the',
    'self-contained UI-test flow, NOT a docker-compose stack. The platform builds and serves the',
    'app and runs WireMock in the SAME container (no docker-compose, no Docker-in-Docker), reading',
    `your stub mappings from the frontend repo. Author them there instead of wiring compose:`,
    '- This OVERRIDES the docker-compose / `docker-compose up` / CI-service-container stand-up',
    '  instructions in your role above: they describe the BACKEND-service flow and do NOT apply to',
    '  this frontend run. Do not create or edit any docker-compose file here.',
    `- Put WireMock stubs under \`${dir}/mappings/*.json\` and their response bodies under`,
    `  \`${dir}/__files/\` (this is WireMock's \`--root-dir\` layout — a bare \`${dir}/\` with no`,
    '  `mappings/` inside starts an empty WireMock that 404s every mocked call).',
    '- Do NOT add or edit a docker-compose file, CI service container, or env-var wiring for this',
    '  frontend — the platform injects the resolved backend URLs and starts WireMock for you.',
    '- Mock the frontend’s BACKEND upstreams that are NOT the live service under test: each',
    '  backend binding whose URL resolves to WireMock. The frontend reads each upstream from an',
    '  injected env var; author realistic stubs (success + the error/edge responses the UI must',
    '  handle) for every route the app calls on those upstreams.',
  ]
  if (mocked.length) {
    lines.push(
      `- Upstreams to mock (their env vars point at WireMock): ${mocked.join(', ')}. Cover the`,
      '  routes the app calls behind each of these.',
    )
  }
  if (live.length) {
    lines.push(
      `- Do NOT mock the live service(s) under test (${live.join(', ')}) — those hit the real`,
      '  ephemeral backend; mocking them would mask the very integration this run exercises.',
    )
  }
  if (!mocked.length && !live.length) {
    lines.push(
      '- This frontend declares no backend bindings yet, so there is nothing to mock; if the app',
      '  calls upstreams, add bindings + stubs for them.',
    )
  }
  return lines.join('\n')
}

/**
 * The built-out system (role) prompt for the mock-builder agent kind, or
 * `undefined` when the kind is not the mock builder (so callers can fall through
 * to the standard phases / acceptance track / generic role).
 */
export function mockSystemPrompt(kind: AgentKind): string | undefined {
  return isMockKind(kind) ? SYSTEM_PROMPT : undefined
}

import type {
  EnvironmentProbeSurface,
  EnvironmentReachabilityNote,
  EnvironmentAccessHandle,
  TestCredentialBrief,
} from '@cat-factory/kernel'
import { FALSE_SUCCESS_SHAPES, FINAL_ANSWER_IN_REPLY } from './shared.js'
import { reachabilityLines } from './standard.js'
// Everything the PLATFORM states about a live environment, rendered by the same code the tester
// steps render it with. A dry run that was told different things than the tester it predicts is a
// dry run whose verdict means nothing (see the module's own note).
import {
  SERVICE_DISCOVERY_GUIDANCE,
  environmentAccessLines,
  testCredentialLines,
  testingContextLines,
  type CredentialGapGuidance,
} from './environment-under-test.js'

// ---------------------------------------------------------------------------
// The AGENT DRY RUN's prompts: the two probers a self-test can dispatch at a freshly
// provisioned ephemeral environment.
//
// What they are FOR is narrower than a Tester, and the difference is the whole point. A Tester
// judges a CHANGE: it exercises this task's requirements and reports whether the software is safe
// to release. A prober judges the SETUP: given the environment the platform just stood up, the
// credentials it was handed and the repository it can read, can an agent work out how to operate
// this service at all? Every finding is about what the PLATFORM failed to supply, which is why
// the report has a `missingContext` list and why an operation the prober could not even attempt
// is a first-class outcome rather than a failure.
//
// Both prompts therefore push hard in the same two directions:
//   - Do something that goes THROUGH AUTHENTICATION. A healthcheck answering 200 proves an
//     ingress exists and nothing about whether an agent can work here, and the platform's verdict
//     refuses `operable` without an authenticated success (`summarizeEnvironmentProbe`), so a
//     prober that only pings has failed its own brief.
//   - Never invent success. A guessed endpoint that 404s is a REPORTABLE FINDING; describing it as
//     a limitation of the service, or quietly dropping it, destroys the only thing the diagnostic
//     produces.
// ---------------------------------------------------------------------------

/** The JSON shape both probers emit, kept in step with `environmentProbeReportSchema`. */
export const ENVIRONMENT_PROBE_SHAPE_HINT = [
  '{',
  '  "summary": string,               // what you did, what worked, and what a human must fix',
  '  "operations": [                  // one entry per operation you attempted OR deliberately did not',
  '    {',
  '      "name": string,              // "list projects", "sign in and open the dashboard"',
  '      "target": string,            // "GET /api/v1/projects", or the UI path you drove',
  '      "authenticated": boolean,    // did this operation actually go through authentication?',
  '      "outcome": "succeeded" | "failed" | "not_attempted",',
  '      "failure": "auth_missing" | "auth_rejected" | "access_unclear" | "endpoint_unknown"',
  '                 | "unreachable" | "timeout" | "server_error" | "bad_request"',
  '                 | "tooling_missing" | "other",   // omit when it succeeded',
  '      "detail": string             // the status code, the message, what you saw',
  '    }',
  '  ],',
  '  "missingContext": string[],      // what the PLATFORM did not tell you and you needed',
  '  "blockers": [                    // things that stopped the whole dry run, not one operation',
  '    { "kind": <same values as "failure">, "detail": string }',
  '  ]',
  '}',
].join('\n')

/**
 * The failure vocabulary explained to the model, one line each.
 *
 * Stated in the prompt rather than left to the shape hint's bare union because the members
 * encode WHOSE PROBLEM each failure is, and that distinction is the report's product. A model
 * choosing `other` for a rejected token, or `server_error` for an endpoint it never found, hands
 * an operator the wrong fix while looking perfectly well-formed.
 */
const FAILURE_VOCABULARY = [
  'Choosing a `failure` value. Pick the one that names WHOSE problem it was, because that is what a human acts on.',
  '- `auth_missing`: you had no credential for this operation and none was supplied to you.',
  '- `auth_rejected`: you sent a credential you were given and the service refused it (401/403).',
  '- `access_unclear`: a credential existed but you could not work out HOW to present it (which header, which flow, which scope).',
  '- `endpoint_unknown`: you could not work out WHAT to call, or where to click, for this operation.',
  '- `unreachable`: nothing answered at all, i.e. DNS, TLS or a refused connection.',
  '- `timeout`: it answered too slowly to complete.',
  '- `server_error`: the service answered with a 5xx or an unhandled error.',
  '- `bad_request`: it rejected your request as malformed (4xx that is not auth), i.e. you had the endpoint but not its contract.',
  '- `tooling_missing`: this container had no usable HTTP client or browser, so the attempt says nothing about the environment.',
  '- `other`: anything else; put the specifics in `detail`.',
].join('\n')

/**
 * The rules that make the report worth reading. Shared by both surfaces verbatim: they are about
 * honesty and about what the diagnostic exists to surface, neither of which differs between
 * calling an API and driving a browser.
 */
const PROBE_RULES = [
  'How to work:',
  // The discovery list is the TESTER's own, verbatim: what a dry run establishes is whether the
  // knowledge a tester will go looking for is actually there to find.
  `1. READ THE REPOSITORY FIRST. It is checked out read-only at the exact revision this environment was built from. Find how the service is addressed and how it authenticates. ${SERVICE_DISCOVERY_GUIDANCE}`,
  '2. Pick 3 to 5 SIMPLE but MEANINGFUL operations: the kind of thing this service exists to do (list something, create something, read one record back). At least ONE of them MUST go through authentication. A healthcheck, a version endpoint or a static asset does not count as one of them: it proves an ingress exists and nothing about whether an agent can operate the service. Include a healthcheck only as a first sanity check, and mark it `authenticated: false`.',
  '3. ATTEMPT each one against the live environment above and record exactly what happened. Read every credential from the environment variables named below; never print a secret value into your reply, your `detail` fields or a log.',
  '4. Report an operation you could NOT attempt as `outcome: "not_attempted"` with the `failure` kind saying why. That is a real finding, not a gap to hide: the whole purpose of this run is to discover what an agent is missing BEFORE a build spends a step on it.',
  '',
  'Rules that make this report worth reading:',
  `- NEVER report an operation as \`succeeded\` unless you saw a real, successful response with plausible content. ${FALSE_SUCCESS_SHAPES}`,
  '- NEVER change the service, the repository or the environment. You do not commit, you do not push, and you avoid destructive calls (no DELETE on data you did not create). Creating a small record and reading it back is fine and is often the most meaningful thing you can do.',
  '- Fill `missingContext` with what the PLATFORM should have told you and did not: a credential you had no reference for, a base path or port you had to guess, an auth flow you had to reverse-engineer, seed data you needed and could not find. Be concrete and name the fix ("no test user credentials were supplied; the service requires a bearer token issued by /auth/token"). This list is the main product of the run.',
  '- If the environment itself never answered, say so once in `blockers` with `unreachable` and do not pad `operations` with attempts you never made.',
  '- Do not grade the run. Report per-operation outcomes and let the platform draw the conclusion.',
  FINAL_ANSWER_IN_REPLY,
].join('\n')

/** The API prober: HTTP calls against a backend service's live ephemeral environment. */
export const ENVIRONMENT_PROBE_API_SYSTEM_PROMPT = [
  'You are an integration-readiness prober. A brand-new ephemeral environment of one service has just been provisioned for you, and you have a read-only checkout of the exact revision it was built from. Your job is to find out whether an autonomous agent handed this environment could actually OPERATE the service: work out what to call, authenticate, and get real work done.',
  '',
  'You are NOT testing the software for defects and you are NOT reviewing the code. You are testing the SETUP: the endpoints, the credentials and the knowledge an agent is given. Everything you could not find out is as important as everything you managed to do.',
  '',
  'Drive the service over HTTP with the tools available in this container (`curl`, or a script in whatever runtime the repo already uses). Speak the protocol the repository says it speaks, over the URL given below.',
  '',
  PROBE_RULES,
  '',
  FAILURE_VOCABULARY,
  '',
  'Respond with ONLY a JSON object (no prose, no code fences) of this shape:',
  ENVIRONMENT_PROBE_SHAPE_HINT,
].join('\n')

/** The UI prober: a browser against a frontend frame's live ephemeral environment. */
export const ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT = [
  'You are an interface-readiness prober. A brand-new ephemeral environment of one frontend application has just been provisioned for you, and you have a read-only checkout of the exact revision it was built from. Your job is to find out whether an autonomous agent handed this environment could actually OPERATE the application: reach it in a browser, sign in, and complete a few real user actions.',
  '',
  'You are NOT testing the application for defects and you are NOT reviewing the code. You are testing the SETUP: the URL, the credentials and the knowledge an agent is given. Everything you could not find out is as important as everything you managed to do.',
  '',
  'Drive the application with Playwright (this container ships it, with a browser). Load the URL below, then act as a user would. Take a screenshot when something is unexpected and describe what you saw in the relevant `detail`. Do not attach images to your reply.',
  '',
  'Signing in is the operation that matters most here: an application whose landing page renders is not an application an agent can use. If the sign-in flow needs an identity provider, a magic link, an emailed code or an OAuth redirect this environment cannot complete, report that as `access_unclear` (or `auth_missing` when no test account exists at all) and say exactly what a human must provide. That is precisely the finding this run exists to produce.',
  '',
  PROBE_RULES,
  '',
  FAILURE_VOCABULARY,
  '',
  'Respond with ONLY a JSON object (no prose, no code fences) of this shape:',
  ENVIRONMENT_PROBE_SHAPE_HINT,
].join('\n')

/** The system prompt for `surface`. */
export function environmentProbeSystemPrompt(surface: EnvironmentProbeSurface): string {
  return surface === 'ui' ? ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT : ENVIRONMENT_PROBE_API_SYSTEM_PROMPT
}

/**
 * How a PROBER records a credential gap, in its own report's words. The states themselves, and
 * whose fault each one is, come from the shared renderers.
 */
const PROBE_GAP_GUIDANCE: CredentialGapGuidance = {
  missing: 'record it as `auth_missing` and say in `missingContext` what is needed',
  unusable: 'treat it as `access_unclear` and say so',
}

/**
 * What the platform can tell the prober about the frame's sealed test credentials.
 *
 * The shared {@link TestCredentialBrief} under its name in this flow. Not a second type: the
 * tester step is handed the same three states through the same renderer, which is what lets a dry
 * run's verdict about "could an agent authenticate here" predict the tester's.
 */
export type EnvironmentProbeSecretsBrief = TestCredentialBrief

/** Everything the platform knows about the target, as the prompt states it. */
export interface EnvironmentProbeBrief {
  surface: EnvironmentProbeSurface
  service: { title: string; description?: string }
  environment: {
    url: string | null
    status: string
    access?: EnvironmentAccessHandle | null
    reachability?: EnvironmentReachabilityNote
  }
  testSecrets: EnvironmentProbeSecretsBrief
  /**
   * The service's own testing prose as its team wrote it on the board, or undefined when nobody
   * has. Rendered either way ({@link testingContextLines}): a prober that does not know the field
   * exists cannot file "nobody told me how this is tested" in `missingContext`, which is the
   * finding the whole run is for.
   *
   * A plain optional rather than the renderer's own two-state brief, because a dry run is always
   * ABOUT a service frame: the stage that composes this reads the field off the frame it just
   * loaded, so the "no service owns this work" state the tester steps can be in cannot arise here.
   */
  testingContext?: string
  repo: { owner: string; name: string; branch: string; serviceDirectory?: string }
}

/**
 * Render the dry run's USER prompt: the system under test, the environment the platform stood up,
 * and the credentials it can reach.
 *
 * Every absence is STATED rather than omitted, and that is load-bearing here in a way it is not
 * in an ordinary prompt. The report's most valuable field is `missingContext`, and a prober that
 * cannot tell "no credentials were configured for this service" from "credentials exist and I was
 * not shown them" cannot fill it usefully: it would report the platform's gap as its own
 * ignorance, or the reverse. Same rule the own-service section follows for exactly the same
 * reason.
 */
export function environmentProbeUserPrompt(brief: EnvironmentProbeBrief): string {
  const lines: string[] = [
    `## The system under test: ${brief.service.title}`,
    '',
    brief.service.description?.trim() ||
      'No description was recorded for this service on the board. Work only from what the repository tells you; do not infer a product or a domain it does not name.',
    '',
    '## The environment the platform just provisioned',
    '',
    `- URL: ${brief.environment.url ?? 'NOT STATED. The provider exposed no URL for this environment. Report this as a blocker; there is nothing for you to drive.'}`,
    `- Provisioning status: ${brief.environment.status}`,
  ]
  // The SAME renderer the tester's environment section uses, so the two cannot disagree about
  // what the platform proved. It is deliberately silent when the name carried and when nothing
  // has probed at all; the prober needs the second of those said out loud, because it decides
  // whether a connection failure is the environment's fault or its own.
  const proved = reachabilityLines(brief.environment.reachability)
  lines.push(
    ...(proved.length > 0
      ? proved
      : [
          '- Reachability: the platform has not proved a route to this environment (either its own name carried, or nothing has dialled it). If you cannot connect, report `unreachable` and say what you tried. Do not assume your tooling is at fault.',
        ]),
  )
  lines.push(...environmentAccessLines(brief.environment.access, PROBE_GAP_GUIDANCE))
  lines.push('', '## Credentials your shell carries', '')
  lines.push(...testCredentialLines(brief.testSecrets, PROBE_GAP_GUIDANCE))
  lines.push('', "## What this service's own team says about testing it", '')
  lines.push(...testingContextLines({ service: 'resolved', context: brief.testingContext }))
  lines.push(
    '',
    '## The repository',
    '',
    `- \`${brief.repo.owner}/${brief.repo.name}\` at branch \`${brief.repo.branch}\`: the exact revision this environment was built from, checked out read-only.`,
  )
  if (brief.repo.serviceDirectory) {
    lines.push(
      `- This service lives in \`${brief.repo.serviceDirectory}\` within that repository. Its siblings are other services: read them only if this one's own code sends you there.`,
    )
  }
  lines.push(
    '',
    'Now probe the environment and report. Remember: at least one authenticated operation, and everything you could not work out goes in `missingContext`.',
  )
  return lines.join('\n')
}

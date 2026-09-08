import type { EnvironmentAccessHandle, TestCredentialBrief } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// What the PLATFORM tells an agent about a live service it did not stand up itself: how to reach
// it, what credential opens it, and which test credentials its shell carries.
//
// Shared by the TESTER steps and the environment DRY RUN, which is the whole reason it is one
// module. A dry run exists to find out whether an agent handed this environment could operate the
// service BEFORE a pipeline spends a tester step finding out; that prediction is only worth
// anything if both are told the same things in the same words. Rendered twice, the two drifted in
// the direction that matters least to notice and most to be wrong about: the prober stated an
// access scheme it could not use and named who was at fault for a missing credential, while the
// tester's own section rendered neither and a failed store read reached it as silence.
//
// What is deliberately NOT shared is the ROLE. A tester judges a CHANGE and reports whether the
// software is safe to release; a prober judges the SETUP and reports what the platform failed to
// supply. Those prompts should not converge. The FACTS they are given should be identical.
// ---------------------------------------------------------------------------

/**
 * The one thing each role must say for itself: how it RECORDS a credential gap in its own report
 * shape.
 *
 * Taken as guidance rather than left out, because naming the fix inside the credentials section is
 * load-bearing: the agent writing "what was missing" can only name a remedy it was told about, and
 * the two report shapes have different words for it (a prober files `missingContext`, a tester
 * files a concern). Everything else about a gap, above all WHOSE gap it is, is stated by the
 * renderers below so the two roles cannot disagree about attribution.
 */
export interface CredentialGapGuidance {
  /** How this role records an operation it had no credential for at all. */
  missing: string
  /** How this role records a credential it could not work out how to present. */
  unusable: string
}

/**
 * The default for every kind whose DELIVERABLE IS ITS REPLY and that has no bespoke report shape:
 * say it in the report and name what is needed. A tester uses this too, its own rules already
 * covering what a failed check does to the greenlight.
 */
export const DEFAULT_CREDENTIAL_GAP_GUIDANCE: CredentialGapGuidance = {
  missing: 'record it as a failure and name the credential that is needed',
  unusable:
    'record it as a failure, and say which header, flow or scope you could not work out rather than reporting the service as broken',
}

/**
 * For a kind whose product is a pushed COMMIT (the implementers: `coder`, `ci-fixer`, `mocker`,
 * the Playwright author, a deployment's own `container-coding` kind).
 *
 * Its own guidance rather than the default, because the default names a REPORT such a kind never
 * writes: those agents legitimately end with no final text at all and their work is in the branch
 * (`deliverableIsReply` is the declaration that decides which it is). Told to "record it as a
 * failure", an implementer reads an instruction to stop and write one up instead of building, so
 * this one names the channel it actually has and says to carry on with the rest.
 */
export const IMPLEMENTER_CREDENTIAL_GAP_GUIDANCE: CredentialGapGuidance = {
  missing:
    'note it where you record the change and name the credential that is needed, then carry on with what you can do without it',
  unusable:
    'say which header, flow or scope you could not work out where you record the change, and treat it as a gap in the SETUP rather than a defect in the service',
}

/**
 * How to authenticate, as the environment's own provider stated it.
 *
 * The `none` scheme is RENDERED rather than skipped: a provider that explicitly issued no
 * credentials and a provider whose access bag never arrived are opposite facts, and an agent told
 * neither files the platform's silence as a missing credential on a service that is genuinely
 * open. So is a scheme declared with nothing usable behind it, which is the case that reads as a
 * broken service to everyone who is not told the credential never arrived.
 *
 * Values are inlined. These are throwaway-environment credentials, minted for an environment that
 * is torn down with the run, and an agent that cannot authenticate reports nothing worth reading;
 * the alternative was a prompt pointing at an out-of-band channel that did not exist.
 */
export function environmentAccessLines(
  access: EnvironmentAccessHandle | null | undefined,
  guidance: CredentialGapGuidance = DEFAULT_CREDENTIAL_GAP_GUIDANCE,
): string[] {
  if (!access) {
    return [
      `- Environment access: NOT STATED. The provider returned no access credentials for this environment. It may be open, or it may expect a credential the platform never received; work out which from the repository, and if an operation needs a credential you do not have, ${guidance.missing}.`,
    ]
  }
  if (access.scheme === 'none') {
    return [
      '- Environment access: the provider states this environment needs NO credential of its own. Any authentication you meet belongs to the application itself.',
    ]
  }
  if (access.scheme === 'bearer' && access.token) {
    return [`- Environment access: send \`Authorization: Bearer ${access.token}\`.`]
  }
  if (access.scheme === 'basic' && access.username !== undefined) {
    return [
      `- Environment access: HTTP Basic, username \`${access.username}\`, password \`${access.password ?? ''}\`.`,
    ]
  }
  if (access.scheme === 'custom_header' && access.headerName) {
    return [
      `- Environment access: send the header \`${access.headerName}: ${access.headerValue ?? ''}\`.`,
    ]
  }
  return [
    `- Environment access: the provider declared the \`${access.scheme}\` scheme and supplied no usable credential for it. The PLATFORM is short a credential here, not the service: if an operation needs it, ${guidance.unusable}.`,
  ]
}

/**
 * The test-credentials section, one wording per {@link TestCredentialBrief} state.
 *
 * The two failure states say who is at fault IN THE PROMPT, because the agent is the one writing
 * up what was missing and it can only name a fix it was told about. Left to the "none configured"
 * wording, a platform that could not open its own store produces a report telling an operator to
 * configure credentials that already exist, which is worse than silence: it is a confident wrong
 * answer with a run's evidence behind it.
 */
export function testCredentialLines(
  brief: TestCredentialBrief,
  guidance: CredentialGapGuidance = DEFAULT_CREDENTIAL_GAP_GUIDANCE,
): string[] {
  if (brief.status === 'unreadable') {
    return [
      `NONE REACHED YOU, AND THE PLATFORM IS AT FAULT. This service may well have test credentials configured on the board: the platform could not open its own sealed credential store to fetch them, so your shell carries none of them. If an operation needs one, ${guidance.missing}, and say that the PLATFORM failed to supply the configured credentials. Do NOT tell a human to configure credentials for this service: that may already be done, and this run cannot tell.`,
    ]
  }
  if (brief.status === 'unwired') {
    return [
      `NONE, AND NONE ARE POSSIBLE HERE. This deployment has no sealed credential store wired, so no service on this board can be handed test credentials. The only auth material you have is whatever the environment section states and whatever the repository documents. If an operation needs a credential, ${guidance.missing}, and say that the DEPLOYMENT has no credential store, rather than asking for this service to be reconfigured.`,
    ]
  }
  if (brief.refs.length === 0) {
    return [
      `NONE. This service has no test credentials configured on the board, so the only auth material you have is whatever the environment section states and whatever the repository itself documents. If an operation needs a credential you do not have, ${guidance.missing}.`,
    ]
  }
  return [
    'Read each of these from the environment (e.g. `$API_TOKEN`). The values are NOT printed here and must never appear in your reply or your logs:',
    ...brief.refs.map((ref) => `- \`${ref.key}\`${ref.description ? `: ${ref.description}` : ''}`),
  ]
}

/**
 * How to work out how to OPERATE a service from its repository: where its address, its protocol
 * and its authentication are actually written down.
 *
 * One list for the tester and the prober, because it is the exact knowledge a dry run exists to
 * test the availability of. A prober that discovers a service through its OpenAPI schema and seed
 * fixtures, and a tester that was only told to read the README, do not exercise the same surface,
 * so a green dry run would say nothing about whether the tester can get in.
 */
export const SERVICE_DISCOVERY_GUIDANCE =
  'Work out how to operate the service from the REPOSITORY, not from guesswork: its ' +
  'OpenAPI/GraphQL schema, route definitions, auth middleware, the README and any docs it ' +
  'points to, seed/fixture data naming test users, and any `.http` or `curl` examples. Prefer ' +
  "what the CODE says over what prose claims, and prefer the repo's own examples over an " +
  'endpoint shape you would expect.'

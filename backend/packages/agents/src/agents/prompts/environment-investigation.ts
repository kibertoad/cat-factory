import type {
  EnvironmentDiagnosis,
  EnvironmentEvidenceBundle,
  EnvironmentInvestigationSubject,
} from '@cat-factory/kernel'
import { determinateRouteCause } from '@cat-factory/kernel'
import { type BespokeSystemPrompt, composeBespokePrompt } from './bespoke.js'
import { FINAL_ANSWER_IN_REPLY, NO_ASSUMED_PRODUCT } from './shared.js'

// ---------------------------------------------------------------------------
// The ENVIRONMENT INVESTIGATOR prompt: the inline LLM call behind the platform's diagnosis of an
// environment that never became usable.
//
// It is the counterpart of the `deploy-fixer` and is deliberately the opposite kind of agent. The
// fixer is a container with a checkout whose product is a pushed commit; this one has no checkout,
// no container and no credentials, because the evidence and the actions both live on the platform
// side of the boundary and provider credentials never reach a container. Its whole product is the
// JSON the engine parses.
//
// The one piece of knowledge the role encodes is the one a human contributed to the incident this
// was written for: look PAST the summary field. A provider that answered `status: online` was
// carrying an offline VM and two unhealthy balancers in the same response, and the diagnosis is
// entirely the observation that two named sources disagreed.
// ---------------------------------------------------------------------------

/**
 * The role/directives split. `product: 'reply'` because the engine PARSES the verdict: the
 * directives half therefore owns the JSON contract, the closed action vocabulary and the
 * evidence-or-say-so rule, so a workspace override of the role cannot leave the engine with
 * nothing to read or with a remediation it never offered.
 */
export const ENVIRONMENT_INVESTIGATION_PROMPT: BespokeSystemPrompt = {
  product: 'reply',
  role:
    'You are a platform engineer investigating why an ephemeral environment a delivery pipeline ' +
    'provisioned never became usable. You are given everything the platform knows about it: the ' +
    "environment record it keeps itself, the whole field bag the provider's own response was " +
    "mapped into, the run's provisioning attempts in order, and (when the provider can answer " +
    "at all) the provider's own account of the environment and its logs.\n\n" +
    'Your job is to settle WHERE the fault is and WHETHER anything is worth trying. Work the way ' +
    'a human would with the same evidence:\n' +
    '- READ PAST THE SUMMARY FIELD. A provider that reports one healthy top-level status while ' +
    'its own sub-resources report otherwise is the single most common shape of this failure. Two ' +
    'named sources disagreeing IS the finding; say which said what.\n' +
    '- LINE THE TIMESTAMPS UP, off the timeline you are given. A readiness verdict that settled ' +
    'before the work that produces readiness even started is a platform fault, not an ' +
    'infrastructure one. The timeline is ONE derived list with every timestamp the platform holds ' +
    'folded into it, so an ordering claim that contradicts an entry in it is simply wrong.\n' +
    '- NEVER INFER THAT SOMETHING DID NOT HAPPEN from its absence in a record that does not log ' +
    'it. The provisioning entries record ATTEMPTS and failures, not each successful status poll; ' +
    'how much polling happened is stated by the poll marker and nowhere else. "There is no entry ' +
    'for it" is a fact about the record, not about the environment. Say that, or say nothing.\n' +
    '- PREFER A DETERMINATE CAUSE TO AN INFERRED ONE. A cause the platform computed from its own ' +
    'inputs (an address it never had, a field it never captured) names an owner and a concrete ' +
    'fix; a fault inferred from the ORDER things appear to have happened in names neither, and ' +
    'ranks below it. Both can be in the answer; only one can be the headline.\n' +
    '- SEPARATE THE LAYERS. The environment being unreachable from where the test ran, the ' +
    'workload being unhealthy, and the infrastructure under it being absent are three different ' +
    'faults with three different owners.\n' +
    '- DISTRUST ABSENCE. A read the platform could not make is recorded as a gap; it is UNKNOWN, ' +
    'never healthy. Never conclude a workload started cleanly from the absence of its logs.\n\n' +
    'You never touch a repository and you never run anything yourself. The platform performs the ' +
    'remediation you ask for and then re-checks the environment; whether it worked is decided by ' +
    'that re-check and never by what you say here.',
  directives:
    '\n\nChoose ONE `action`, and only from the list the prompt says is offered this round. An ' +
    'action outside it is discarded and read as `stop`, so a remedy you think is right but that ' +
    'is not offered belongs in `actionRationale` instead. `stop` when nothing here is retryable ' +
    'and a person has to act: that is a legitimate, useful answer and it is far better than a ' +
    'speculative retry, because the named cause it carries is the whole reason you were asked.\n' +
    'Cite what you actually read. Every `evidence` entry names its `source` (a key from the ' +
    'provision fields, a provider fact, a timeline entry) and states the fact in your words. Do ' +
    'not invent a field you were not shown, and return an EMPTY evidence array rather than a ' +
    'padded one when the bundle genuinely supported nothing.\n' +
    'Reply with ONLY a JSON object of this shape, with no prose around it and no code fences:\n' +
    '{\n' +
    '  "faultLayer": "provider" | "platform" | "deployment" | "unknown",\n' +
    '  "summary": "one paragraph: what is wrong, in plain words",\n' +
    '  "evidence": [{ "source": "where the fact came from", "statement": "the fact" }],\n' +
    '  "action": "one of the offered actions",\n' +
    '  "actionRationale": "why that action, in a sentence or two"\n' +
    '}\n' +
    'Use `faultLayer: "unknown"` when the evidence did not settle it. It is a real answer: ' +
    '"we could not tell" and "the provider is broken" send different people to different places.\n' +
    // The shared rule every inline engine kind carries, and it binds here for its own reason as
    // well as the shared one: the vendor behind an environment is not in the evidence, so an
    // investigator that names one has invented the layer it is blaming.
    NO_ASSUMED_PRODUCT +
    ' ' +
    FINAL_ANSWER_IN_REPLY,
}

/** The shipped prompt, composed. A workspace override replaces the role half only. */
export const ENVIRONMENT_INVESTIGATION_SYSTEM_PROMPT = composeBespokePrompt(
  ENVIRONMENT_INVESTIGATION_PROMPT,
)

/** Section separator, matching the other assembled inline prompts. */
function section(title: string, body: string): string {
  return `--- ${title} ---\n${body}`
}

function renderRecord(bundle: EnvironmentEvidenceBundle): string {
  const env = bundle.environment
  const lines = [
    `id: ${env.id ?? '(none recorded)'}`,
    `status: ${env.status}`,
    `url: ${env.url ?? '(none published)'}`,
    `provisionType: ${env.provisionType ?? '(unrecorded)'}`,
    `engine: ${env.engine ?? '(unrecorded)'}`,
    `expiresAt: ${env.expiresAt === null ? '(no TTL)' : new Date(env.expiresAt).toISOString()}`,
    `lastError: ${env.lastError ?? '(none)'}`,
  ]
  return section("The platform's own environment record", lines.join('\n'))
}

function renderProvisionFields(bundle: EnvironmentEvidenceBundle): string {
  const entries = Object.entries(bundle.provisionFields)
  if (entries.length === 0) {
    return section(
      'Provision fields captured from the provider',
      'The provider captured no fields for this environment (or they could not be read; see the ' +
        'timeline). This is an ABSENCE, not a clean result.',
    )
  }
  const body = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return section(
    "Provision fields captured from the provider's own response",
    `${body}\n\nThese are the provider's words, mapped verbatim at provision and on every poll.`,
  )
}

function renderTimeline(bundle: EnvironmentEvidenceBundle): string {
  if (bundle.timeline.length === 0) {
    return section(
      "The run's provisioning timeline",
      'No provisioning attempts were recorded for this run. Either this deployment keeps no ' +
        'provisioning log, or nothing was ever appended. The two are indistinguishable here, so ' +
        'draw no conclusion from the silence.',
    )
  }
  const body = bundle.timeline
    .map((entry) => {
      const stamp = entry.at === null ? '(undated)' : new Date(entry.at).toISOString()
      return `${stamp}  ${entry.label}${entry.detail ? `\n    ${entry.detail}` : ''}`
    })
    .join('\n')
  return section(
    "This environment's timeline (oldest first)",
    `${body}\n\nEvery timestamp the platform holds is already folded into this one list: the ` +
      "record's own dates, the run's provisioning attempts, when the route was dialled, and the " +
      'marker for how much status polling happened. It is the whole dated record, and it is NOT a ' +
      'log of everything that happened: a successful status poll appears in the poll marker and ' +
      'nowhere else.',
  )
}

/**
 * What the platform knows about REACHING this environment, and the cause that evidence settles on
 * its own.
 *
 * Rendered as its own section as well as being folded into the timeline, because the two answer
 * different questions: the timeline answers WHEN the platform dialled, this answers what it had to
 * dial. The determinate cause is COMPUTED by the platform (kernel's `determinateRouteCause`) and
 * never inferred here: a ranking the model is asked to derive is a ranking its own rationale does
 * not have to explain, and the failure this section exists for subordinated exactly this fact
 * ("no balancer or address field was captured at all") to a headline blaming a platform gate that
 * had worked correctly.
 */
function renderRoute(bundle: EnvironmentEvidenceBundle): string {
  const { candidates, proof, unreadable } = bundle.route
  if (unreadable) return section('Reaching this environment', unreadable)
  const lines = [
    candidates.length === 0
      ? "addresses the provider stated for this environment's URL: NONE. Its own name was the " +
        'only target that could be tried.'
      : `addresses the provider stated, in ITS order: ${candidates
          .map((c) => (c.label ? `${c.address} (${c.label})` : c.address))
          .join(', ')}`,
  ]
  if (!proof) {
    lines.push(
      'Nothing has dialled this environment, so nothing is known about whether it can be ' +
        'reached. That is an ABSENCE of a check, never a passed one.',
    )
  } else {
    lines.push(
      `proof: ${proof.state}${proof.reason ? ` (${proof.reason})` : ''}, taken at ` +
        `${new Date(proof.checkedAt).toISOString()}` +
        `${proof.via ? `, carried via ${proof.via}` : ''}.`,
      proof.attempts.length === 0
        ? 'No target was tried.'
        : `Targets tried, in order: ${proof.attempts
            .map((a) => `${a.target} (${a.outcome}${a.detail ? `: ${a.detail}` : ''})`)
            .join(', ')}.`,
      'A `not_reached` proof is a verdict about the environment; `inconclusive` and `unproved` ' +
        'are admissions about the platform and settle nothing about it.',
    )
  }
  const cause = determinateRouteCause(candidates, proof)
  if (cause) {
    lines.push(
      `\nA DETERMINATE CAUSE the platform already computed from this evidence: ${cause}\nThis ` +
        'ranks ahead of anything inferred, so make it the headline unless something else here ' +
        'contradicts it.',
    )
  }
  return section('Reaching this environment', lines.join('\n'))
}

/** Compile-time totality guard for {@link renderReadinessWait}. */
function unhandledReadinessWait(kind: never): string {
  return `The platform recorded an unrecognised readiness state (${JSON.stringify(kind)}).`
}

/**
 * What the readiness wait says about this failure, in the three ways it can say something.
 *
 * The distinction is load-bearing right above the role's "LINE THE TIMESTAMPS UP" directive: an
 * absent duration used to render as "there was a live verdict and nothing waited", which is a
 * CLAIM, and it was false on every failure route except the provider's own declared failure.
 */
function renderReadinessWait(failure: EnvironmentEvidenceBundle['failure']): string {
  switch (failure.readinessWait) {
    case 'waited':
      return (
        `The readiness wait ran for ${Math.round((failure.waitedMs ?? 0) / 1000)} seconds before ` +
        'it was given up on.'
      )
    case 'verdict_without_wait':
      return 'Nothing waited on this environment: there was a live verdict and it was not ready.'
    case 'not_reached':
      return (
        'This failure happened BEFORE any readiness judgement, so there is no readiness verdict ' +
        'and no wait duration. Draw no conclusion from either; the provisioning timeline below is ' +
        'the only account of how long the attempt ran.'
      )
    default:
      return unhandledReadinessWait(failure.readinessWait)
  }
}

function renderDiagnosis(diagnosis: EnvironmentDiagnosis): string {
  const parts: string[] = []
  parts.push(
    diagnosis.facts.length === 0
      ? 'Facts: the provider returned none.'
      : `Facts:\n${diagnosis.facts
          .map((fact) => {
            const verdict =
              fact.healthy === undefined
                ? '(provider offers no verdict)'
                : fact.healthy
                  ? '(provider considers this healthy)'
                  : '(provider considers this UNHEALTHY)'
            return `  ${fact.key} = ${fact.value} ${verdict}`
          })
          .join('\n')}`,
  )
  for (const entry of diagnosis.logs ?? []) {
    parts.push(
      `Log from ${entry.source}${entry.truncated ? ' (TAIL only; the start was dropped)' : ''}:\n${entry.text}`,
    )
  }
  if (diagnosis.gaps?.length) {
    parts.push(
      `Reads the provider could NOT make (treat each as UNKNOWN, never as healthy):\n${diagnosis.gaps
        .map(
          (gap) =>
            `  ${gap.read}: ${gap.reason}${gap.permanent ? ' (this will never answer differently)' : ''}`,
        )
        .join('\n')}`,
    )
  }
  return section("The provider's own account", parts.join('\n\n'))
}

/**
 * Assemble one investigation prompt from the evidence bundle. Pure, so the whole framing can be
 * exercised, including every degraded shape (no record, no fields, no provider diagnosis),
 * without a model.
 *
 * The bundle's absences are RENDERED rather than skipped, which is the point of the function: a
 * section quietly omitted reads exactly like a section that came back clean, and the investigator
 * would then reason from a silence the platform never earned.
 */
export function renderEnvironmentInvestigationPrompt(
  subject: EnvironmentInvestigationSubject,
): string {
  const { evidence, offeredActions } = subject
  const parts: string[] = [
    section(
      'What went wrong',
      [
        `The run recorded this provisioning failure:\n${evidence.failure.error}`,
        evidence.failure.reason
          ? `The platform classified the cause as: ${evidence.failure.reason}`
          : 'The platform could not classify the cause.',
        renderReadinessWait(evidence.failure),
      ].join('\n\n'),
    ),
    renderRecord(evidence),
    renderProvisionFields(evidence),
    renderRoute(evidence),
    renderTimeline(evidence),
  ]
  if (evidence.diagnosis) parts.push(renderDiagnosis(evidence.diagnosis))
  if (evidence.diagnosisUnavailable) {
    parts.push(section("The provider's own account is unavailable", evidence.diagnosisUnavailable))
  }
  if (evidence.evidenceCaps?.length) {
    parts.push(
      section(
        'What the platform did NOT pass on',
        `${evidence.evidenceCaps.map((cap) => `- ${cap}`).join('\n')}\n\nThese were held back by ` +
          'the platform for size, not refused by the provider. Treat each as UNKNOWN.',
      ),
    )
  }
  parts.push(
    section(
      'What the platform will do if you ask',
      `${offeredActions.join(', ')}\n\nAnything else is discarded and read as "stop".`,
    ),
  )
  return parts.join('\n\n')
}

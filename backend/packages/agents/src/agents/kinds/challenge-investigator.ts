import { prReviewChallengeOutputSchema } from '@cat-factory/contracts'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `challenge-investigator` agent kind — the read-only investigator that RE-EXAMINES a single
// PR-review finding a human CHALLENGED.
//
// After the `pr-reviewer` deep-reviews a PR and the run parks for a human to curate the findings,
// the human can CHALLENGE any finding — optionally attaching a specific question / concern. That
// dispatches this kind as a HELPER off the parked `pr-reviewer` step (a read-only
// `container-explore` clone of the base branch — the `pr-reviewer` template), scoped to the ONE
// challenged finding. It digs into the FULL source (the finding's file, its call sites, its tests,
// and the PR diff prepared in `.cat-context/pr-diff.md`) and returns a verdict: UPHOLD the finding
// (optionally strengthening / clarifying its body) or RETRACT it (with a justification). The engine
// applies that verdict to the finding in place and re-parks the review — an upheld finding's body is
// amended, a retracted finding is auto-deselected and shown struck-through beside the justification.
//
// It is configured SEPARATELY from the reviewer: because it is its own agent kind, a workspace can
// point it at a different (stronger) model via a per-kind model-preset override — model routing keys
// off the dispatched kind, and this helper dispatches under `challenge-investigator`.
//
// There is NO `presentation`: this is never a palette step — its output is consumed by the engine
// (applied to the finding) and rendered through the `pr-reviewer` step's dedicated deep-review
// window, not the generic-structured viewer. It is scoped to the run's PRIMARY repo (single-repo
// review tasks), exactly like the reviewer, so this kind does NOT fan out.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for a
// registered `container-explore` kind (see `applySurfaceDirectives`), so the prompt below is only
// the core role.
// ---------------------------------------------------------------------------

export const CHALLENGE_INVESTIGATOR_KIND = 'challenge-investigator'

/**
 * The investigator's structured verdict. The lenient (`v.fallback`) shape is the SINGLE source of
 * truth in `@cat-factory/contracts` (`prReviewChallengeOutputSchema`) — shared with the engine's
 * coercion onto the finding — so a partially-malformed reply degrades to a safe default (an
 * unreadable verdict reads as `upheld`, KEEPING the finding) rather than failing the run.
 */
export const prReviewChallenge = defineStructuredOutput(prReviewChallengeOutputSchema)

export type PrReviewChallengeOutput = ReturnType<typeof prReviewChallenge.parse>

export const CHALLENGE_INVESTIGATOR_SYSTEM_PROMPT =
  'You are a rigorous, impartial senior engineer RE-EXAMINING a single code-review finding that a ' +
  'human has CHALLENGED. Another reviewer raised the finding on an open pull request; the human is ' +
  'not convinced and wants it validated against the ACTUAL code before acting on it. The finding ' +
  'under challenge — its file, line, severity, category, title and detail — and the human’s ' +
  'specific concern (or, when they gave none, a generic instruction to dig deeper) are provided to ' +
  'you in the task context.\n' +
  'You have the full base checkout, and the PR’s changed-file list + per-file diff have usually ' +
  'been prepared for you in `.cat-context/pr-diff.md` — read that first. Fetch the PR head into the ' +
  'checkout when you need full file bodies:\n' +
  '  git fetch origin pull/<number>/head:pr-head\n' +
  'Then INVESTIGATE the finding grounded in the real source: open the file and line it concerns, ' +
  'follow the relevant call sites, read the surrounding code and any tests, and check whether the ' +
  'concern actually holds ON THIS PR’s change — not in the abstract. Weigh the human’s specific ' +
  'challenge honestly; if they gave none, still justify the finding’s grounding and validate it is ' +
  'accurate AND relevant to this change.\n' +
  'Reach ONE of two verdicts:\n' +
  '- "upheld": the finding holds up. Keep it. When your investigation lets you make it SHARPER — ' +
  'more precise, better grounded, correctly severity-rated — provide the improved body in the ' +
  '"revised*" fields (only the ones you are changing); otherwise omit them and the finding stands ' +
  'as written. Either way, explain in "justification" why it holds (cite the specific code).\n' +
  '- "retracted": the finding does NOT hold up — it is wrong, based on a misreading, already ' +
  'handled elsewhere, or not relevant to this change. Explain precisely WHY in "justification" so ' +
  'the human can trust the retraction.\n' +
  'Be impartial: do not reflexively defend the finding, and do not retract it just because it was ' +
  'challenged. Follow the evidence. Do NOT change any code — you only investigate and report.\n' +
  'Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "verdict": "upheld | retracted",\n' +
  '  "justification": "why the finding holds up, or why it does not — grounded in the specific code",\n' +
  '  "revisedTitle": "a sharper headline (only when upheld and you are improving it)",\n' +
  '  "revisedDetail": "a clarified/strengthened finding body (only when upheld and improving it)",\n' +
  '  "revisedSeverity": "blocker | high | medium | low | nit (only when re-assessing severity)",\n' +
  '  "revisedSuggestedFix": "a concrete suggested change (only when upheld and you can offer one)"\n' +
  '}'

export const CHALLENGE_INVESTIGATOR_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: CHALLENGE_INVESTIGATOR_KIND,
    systemPrompt: CHALLENGE_INVESTIGATOR_SYSTEM_PROMPT,
    // Reads and judges code to validate the finding, so the engine folds the review task's
    // selected best-practice / guideline fragments into its prompt — exactly like `pr-reviewer`.
    traits: [CODE_AWARE_TRAIT],
    // Read-only FULL clone of the repo's BASE (default) branch — a review task targets an EXISTING
    // external PR, so there is no work branch; the prompt fetches the PR head by number and diffs
    // against the base. Full history so the base..head diff resolves. `agent.output` is derived
    // from the schema. No `presentation`: never a palette step (see the header note).
    agent: { surface: 'container-explore', clone: { branch: 'base', full: true } },
    structuredOutput: prReviewChallenge,
  },
]

/**
 * Register the challenge-investigator kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerChallengeInvestigatorAgent(registry: AgentKindRegistry): void {
  registry.registerAll(CHALLENGE_INVESTIGATOR_AGENT_KINDS)
}

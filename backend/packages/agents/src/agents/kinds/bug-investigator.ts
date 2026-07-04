import * as v from 'valibot'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The `bug-investigator` agent kind — the read-only, multi-repo investigation that
// OPENS a bug-fix / bug-triage pipeline.
//
// It was a thin prose role (an enriched Markdown report); it is upgraded here to a
// STRUCTURED `container-explore` kind through the public `registerAgentKind` seam (the
// `security-auditor` worked example is the shape copied), keeping the SAME kind id so the
// existing `pl_bugfix` preset inherits the upgrade with no pipeline change. It clones the
// primary repo read-only PLUS every connected involved-service repo as sibling checkouts
// (the service-connections `peerRepos` job body, gated on `MULTI_REPO_FANOUT_KINDS`), so a
// cross-service bug is traced across every repo it touches — not prompt-only.
//
// Its structured output drives the downstream clarity gate: `clarity` decides whether the
// gate auto-passes (`clear`) or parks a human for answers (`needs_clarification`, seeding
// the review items from `questions`), and a post-completion resolver renders a prose digest
// into `step.output` so the estimator / repro-test / coder read it via `priorOutputs`. The
// structured object stays on `step.custom`, rendered by the stock `generic-structured` view.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for
// a registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`), so
// the prompt below is only the core role.
// ---------------------------------------------------------------------------

export const BUG_INVESTIGATOR_KIND = 'bug-investigator'

/**
 * The bug investigator's structured finding. Lenient (`v.fallback`/`v.optional`) exactly like
 * `securityAssessment` so a partially-malformed reply degrades to sensible defaults rather than
 * failing the whole run: an unreadable `clarity` reads as `clear` (advance rather than falsely
 * park), and each list degrades to empty rather than discarding the object.
 */
export const bugInvestigation = defineStructuredOutput(
  v.object({
    /** Whether the report is fixable as-is (`clear`) or needs the reporter to clarify. */
    clarity: v.fallback(v.picklist(['clear', 'needs_clarification']), 'clear'),
    /** What the bug is, restated in the investigator's own words with the context it found. */
    summary: v.fallback(v.optional(v.string()), undefined),
    /** Ranked candidate root causes (most likely first). */
    rootCauseHypotheses: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** Each repo the bug touches, with the relevant paths + why it is implicated. */
    affectedRepos: v.fallback(
      v.array(
        v.fallback(
          v.object({
            repo: v.fallback(v.string(), ''),
            frameId: v.fallback(v.optional(v.string()), undefined),
            paths: v.fallback(v.array(v.fallback(v.string(), '')), []),
            rationale: v.fallback(v.optional(v.string()), undefined),
          }),
          { repo: '', paths: [] },
        ),
      ),
      [],
    ),
    /** Concrete reproduction / failing-test ideas for the downstream repro-test step. */
    suggestedReproductions: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** Non-empty ONLY when `clarity === 'needs_clarification'`: what to ask the reporter. */
    questions: v.fallback(v.array(v.fallback(v.string(), '')), []),
  }),
)

export type BugInvestigation = ReturnType<typeof bugInvestigation.parse>

const BUG_INVESTIGATOR_SYSTEM_PROMPT =
  'You are a senior engineer triaging a bug report against this codebase before anyone fixes ' +
  'it. Read the relevant code paths, tests and configuration across every checked-out ' +
  'repository to understand the reported behaviour and where it lives. When more than one ' +
  'repository is present (a cross-service bug), investigate all of them — the fault may be in ' +
  'a service other than the one the report names. Decide whether the report is fixable AS-IS ' +
  'or whether you must ask the reporter for missing detail (no reproduction steps, no ' +
  'expected-vs-actual, ambiguous scope). Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "clarity": "clear" | "needs_clarification",\n' +
  '  "summary": "what the bug is, restated with the technical context you found",\n' +
  '  "rootCauseHypotheses": ["ranked candidate root causes, most likely first"],\n' +
  '  "affectedRepos": [{ "repo": "owner/name", "frameId": "optional", "paths": ["files"], "rationale": "why" }],\n' +
  '  "suggestedReproductions": ["concrete repro / failing-test ideas"],\n' +
  '  "questions": ["only when needs_clarification: what to ask the reporter"]\n' +
  '}\n' +
  'Set "clarity" to "needs_clarification" ONLY when you genuinely cannot confidently locate the ' +
  'fault without more input, and then make "questions" a non-empty, specific, answerable list ' +
  'phrased for the bug reporter. Otherwise set "clarity" to "clear" and leave "questions" empty. ' +
  'Only propose a root-cause hypothesis when you are reasonably confident — a low-confidence guess ' +
  'would misdirect the fix. Do not propose or write a fix.'

export const BUG_INVESTIGATOR_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: BUG_INVESTIGATOR_KIND,
    systemPrompt: BUG_INVESTIGATOR_SYSTEM_PROMPT,
    // Read-only checkout of the primary repo's base branch (+ any peer repos as siblings,
    // wired by the executor's multi-repo fan-out). `agent.output` is derived from the schema.
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: bugInvestigation,
    presentation: {
      label: 'Bug Investigator',
      icon: 'i-lucide-search-code',
      color: '#38bdf8',
      description:
        'Read-only, multi-repo codebase investigation that traces a bug to its root cause and ' +
        'decides whether the report is fixable as-is or needs the reporter to clarify.',
      category: 'review',
      // The structured finding opens in the shared generic viewer (no bespoke window); the
      // clarity gate consumes `clarity`/`questions` server-side.
      resultView: 'generic-structured',
    },
  },
]

/**
 * Register the bug-investigator kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerBugInvestigatorAgent(registry: AgentKindRegistry): void {
  registry.registerAll(BUG_INVESTIGATOR_AGENT_KINDS)
}

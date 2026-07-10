import * as v from 'valibot'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The `fork-proposer` agent kind — the read-only proposer that OPENS the optional
// implementation-fork decision phase on the Coder step.
//
// Before the Coder writes any code, this kind is dispatched as a HELPER off the coder
// step (a `container-explore`, read-only clone of the base branch — the `bug-investigator`
// template) to AGGRESSIVELY surface the MATERIALLY different ways the task could be
// implemented. Its structured JSON is recorded into the coder step's `forkDecision` state;
// the engine then parks the run for a human to pick a proposed fork, enter their own
// free-text approach, or chat about the forks before deciding. The chosen fork is folded
// into the Coder's prompt as a binding directive.
//
// There is NO `presentation`: this is never a palette step — its output renders through the
// coder step's dedicated fork-decision window, not the generic-structured viewer. It is
// scoped to the run's PRIMARY repo (single-repo tasks); a per-repo fork set is an explicit
// follow-up (see the initiative doc's open question 4), so this kind does NOT fan out.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for
// a registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`), so
// the prompt below is only the core role.
// ---------------------------------------------------------------------------

export const FORK_PROPOSER_KIND = 'fork-proposer'

/**
 * The proposer's structured finding. Lenient (`v.fallback`/`v.optional`) exactly like
 * `bugInvestigation` so a partially-malformed reply degrades to sensible defaults rather than
 * failing the run: an unreadable `singlePath` reads as `false`, and each list degrades to
 * empty rather than discarding the object (the engine then treats <2 usable forks as a single
 * path). Mirrors the contracts `forkProposalSchema` shape the engine records onto the step.
 */
export const forkProposal = defineStructuredOutput(
  v.object({
    /** The proposer's read of where the change lands (the seam it identified). */
    seamSummary: v.fallback(v.optional(v.string()), undefined),
    /** The materially different approaches (target 2–4). */
    forks: v.fallback(
      v.array(
        v.fallback(
          v.object({
            title: v.fallback(v.string(), ''),
            summary: v.fallback(v.string(), ''),
            approach: v.fallback(v.string(), ''),
            tradeoffs: v.fallback(v.array(v.fallback(v.string(), '')), []),
            riskNotes: v.fallback(v.optional(v.string()), undefined),
            recommended: v.fallback(v.optional(v.boolean()), undefined),
          }),
          { title: '', summary: '', approach: '', tradeoffs: [] },
        ),
      ),
      [],
    ),
    /** True ONLY when any competent senior engineer would implement it the same way. */
    singlePath: v.fallback(v.boolean(), false),
    /** Why the single-path escape hatch fired (required when `singlePath`). */
    singlePathReason: v.fallback(v.optional(v.string()), undefined),
  }),
)

export type ForkProposalOutput = ReturnType<typeof forkProposal.parse>

export const FORK_PROPOSER_SYSTEM_PROMPT =
  'You are a senior engineer deciding HOW to implement a task, before anyone writes code. ' +
  'Read the relevant code first — the seams, call sites, data shapes and tests the task touches — ' +
  'and state where the change lands in "seamSummary". Then enumerate every MATERIALLY different ' +
  'way to implement it: a different seam (patch the call site vs introduce/refactor an ' +
  'abstraction), a different data shape (migrate the schema vs adapt the mapper), a different ' +
  'blast radius (a targeted patch vs a refactor), a different delivery strategy (behind a flag vs ' +
  'direct). Target 2–4 forks. Two forks are materially different ONLY if they lead to different ' +
  'code being reviewed, different risk, or different future maintenance — naming/style variants of ' +
  'one approach are ONE fork, not two. Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "seamSummary": "where the change lands: the modules/files/seams involved",\n' +
  '  "forks": [{\n' +
  '    "title": "short headline of the approach",\n' +
  '    "summary": "one-line gist",\n' +
  '    "approach": "the concrete plan: the modules/files touched and the order of work",\n' +
  '    "tradeoffs": ["honest pros AND cons, in both directions"],\n' +
  '    "riskNotes": "anything irreversible: schema, wire contracts, data",\n' +
  '    "recommended": true | false\n' +
  '  }],\n' +
  '  "singlePath": true | false,\n' +
  '  "singlePathReason": "only when singlePath: why any competent engineer would do it the same way"\n' +
  '}\n' +
  'Per fork, make "approach" concrete (the modules/files touched and the order of work), give ' +
  'honest "tradeoffs" in BOTH directions, and fill "riskNotes" for anything irreversible. Mark ' +
  'EXACTLY ONE fork "recommended": true and justify it inside its tradeoffs; every other fork is ' +
  '"recommended": false. Set "singlePath" to true ONLY when any competent senior engineer would ' +
  'implement it the same way (a trivial/obvious fix, or the codebase already prescribes the ' +
  'pattern) — then fill "singlePathReason" and return that ONE fork. Fabricating cosmetic forks ' +
  'for trivial work is a failure; missing a genuine patch-vs-refactor or migrate-vs-adapt split ' +
  'is a worse one. Do not write or propose to write the code itself — only the approaches.'

export const FORK_PROPOSER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: FORK_PROPOSER_KIND,
    systemPrompt: FORK_PROPOSER_SYSTEM_PROMPT,
    // Read-only checkout of the primary repo's base branch. `agent.output` is derived
    // from the schema. No `presentation`: never a palette step (see the header note).
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: forkProposal,
  },
]

/**
 * Register the fork-proposer kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerForkProposerAgent(registry: AgentKindRegistry): void {
  registry.registerAll(FORK_PROPOSER_AGENT_KINDS)
}

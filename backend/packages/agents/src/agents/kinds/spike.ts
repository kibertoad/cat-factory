import type { AgentRunContext } from '@cat-factory/kernel'
import * as v from 'valibot'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { linkedContextSection } from '../prompts/standard.js'

// ---------------------------------------------------------------------------
// The `spike` agent kind — a TIMEBOXED investigation/research task that answers a
// question against the given context (the task brief, linked docs/issues, and the
// codebase) and produces a FINDINGS document. It writes no code and opens no PR.
//
// It is a read-only `container-explore` kind registered through the public
// `registerAgentKind` seam (the `bug-investigator` / `pr-reviewer` / `environment-analyst`
// shape is the model copied): it clones the primary repo read-only, investigates, and
// returns a structured findings object (with a mandatory prose `findings` body). The
// structured JSON lands on `result.custom` → `step.custom` and renders through the shared
// `generic-structured` result view — no bespoke window and no harness handler.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for
// a registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`), so
// the prompt below is only the core role.
//
// Durability (committing the findings to `docs/research/<slug>.md`) and the repo-less story
// are deliberately a LATER slice (see docs/initiatives/spike-task-support.md gaps 4 + 6);
// this slice lands the happy path: the spike kind, the `pl_spike` pipeline, and the
// `spike → pl_spike` type default.
// ---------------------------------------------------------------------------

export const SPIKE_KIND = 'spike'

/**
 * The spike's structured finding. Lenient (`v.fallback`/`v.optional`) exactly like
 * `bugInvestigation` so a partially-malformed reply degrades to sensible defaults rather than
 * failing the whole run: each list degrades to empty and an unreadable `confidence` reads as
 * `medium`. The prose `findings` body is the primary human-readable deliverable; the rest of
 * the shape lets a reader (and a future result view / verdict gate) act on the outcome.
 */
export const spikeFindings = defineStructuredOutput(
  v.object({
    /** The investigation question, restated in the spike's own words. */
    question: v.fallback(v.optional(v.string()), undefined),
    /** The findings themselves — a prose (Markdown) write-up. The primary deliverable. */
    findings: v.fallback(v.optional(v.string()), undefined),
    /** Each option weighed, with its trade-offs (empty when the spike compared no options). */
    optionsCompared: v.fallback(
      v.array(
        v.fallback(
          v.object({
            option: v.fallback(v.string(), ''),
            pros: v.fallback(v.array(v.fallback(v.string(), '')), []),
            cons: v.fallback(v.array(v.fallback(v.string(), '')), []),
            notes: v.fallback(v.optional(v.string()), undefined),
          }),
          { option: '', pros: [], cons: [] },
        ),
      ),
      [],
    ),
    /** The recommended answer / course of action the findings support. */
    recommendation: v.fallback(v.optional(v.string()), undefined),
    /** What remains unresolved, or was deliberately left out of scope within the timebox. */
    openQuestions: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** How confident the spike is in its recommendation. */
    confidence: v.fallback(v.picklist(['low', 'medium', 'high']), 'medium'),
  }),
  // The findings object IS the deliverable, so fail the run loudly on an unusable final answer
  // rather than laundering an empty findings doc through repair (like `environment-analyst`).
  { failOnUnusableFinal: true },
)

export type SpikeFindings = ReturnType<typeof spikeFindings.parse>

const SPIKE_SYSTEM_PROMPT =
  'You are a senior engineer running a timeboxed SPIKE — a focused investigation that answers a ' +
  'question, weighs options, or de-risks a decision BEFORE anyone commits to building. Read the ' +
  'task brief, any linked context (requirements / RFCs / PRDs / tracker issues) and the relevant ' +
  'code, tests and configuration in the checkout to ground your answer in what the codebase ' +
  'actually does — not what it ideally would. This is RESEARCH: you write no code, change no ' +
  'files and open no pull request; your deliverable is the findings. Size the depth to the ' +
  'timebox: go breadth-first, then depth only where it changes the answer, and say plainly what ' +
  'you deliberately did not chase. Where a choice is genuinely open, lay out the options with ' +
  'their trade-offs and make a clear recommendation rather than hedging; call out the assumptions ' +
  'and the questions that remain. Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "question": "the question this spike set out to answer, restated in your own words",\n' +
  '  "findings": "the findings themselves as Markdown prose — what you learned and why it matters",\n' +
  '  "optionsCompared": [{ "option": "name", "pros": ["…"], "cons": ["…"], "notes": "optional" }],\n' +
  '  "recommendation": "the answer / course of action your findings support",\n' +
  '  "openQuestions": ["what is still unresolved or deliberately out of scope for the timebox"],\n' +
  '  "confidence": "low" | "medium" | "high"\n' +
  '}\n' +
  'Make "findings" substantive and self-contained — it is what a human reads to act on the spike. ' +
  'Leave "optionsCompared" empty when the spike was not an options comparison. Only claim "high" ' +
  'confidence when the evidence genuinely supports it.'

/**
 * The spike's specific creation fields, folded into the brief as the investigation's criteria.
 * `researchQuestion` / `optionsToCompare` are the existing research keys (shared with the
 * `document` type's `research` doc-kind); `timeboxHours` is the spike's scope-discipline budget.
 * Empty when none are filled, so a bare spike task's prompt is unchanged.
 */
function spikeBriefSection(context: AgentRunContext): string {
  const fields = context.block.taskTypeFields
  const lines: string[] = []
  const question = fields?.researchQuestion?.trim()
  if (question) lines.push(`Research question: ${question}`)
  const options = fields?.optionsToCompare?.trim()
  if (options) lines.push(`Options to compare: ${options}`)
  const timebox = fields?.timeboxHours
  if (typeof timebox === 'number' && timebox > 0) {
    lines.push(
      `Timebox: ~${timebox} hour${timebox === 1 ? '' : 's'}. Size the investigation to it — ` +
        'prefer breadth-then-depth, and list what you deliberately did not chase.',
    )
  }
  return lines.length ? ['', 'Investigation criteria:', ...lines].join('\n') : ''
}

function spikeUserPrompt(context: AgentRunContext): string {
  const { block, pipelineName, priorOutputs } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Spike: ${block.title}`,
    `Brief: ${block.description?.trim() || '(none provided — infer the question from the title and any linked context)'}`,
  ]
  const brief = spikeBriefSection(context)
  if (brief) lines.push(brief)
  // Container kind ⇒ the linked-context bodies are materialised on disk; point at them.
  const linked = linkedContextSection(context, { materialized: true })
  if (linked) lines.push(linked)
  if (priorOutputs.length) {
    lines.push('', 'Work from earlier steps in this pipeline (build on it, do not repeat it):')
    for (const p of priorOutputs) lines.push(`### ${p.agentKind}`, p.output)
  }
  lines.push('', 'Investigate and produce the findings.')
  return lines.join('\n')
}

export const SPIKE_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: SPIKE_KIND,
    systemPrompt: SPIKE_SYSTEM_PROMPT,
    userPrompt: spikeUserPrompt,
    // Read-only checkout of the primary repo's base branch — a spike reads the codebase as-is;
    // it never edits or opens a PR. `agent.output` is derived from the schema.
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: spikeFindings,
    presentation: {
      label: 'Spike',
      icon: 'i-lucide-flask-conical',
      color: '#f59e0b',
      description:
        'Timeboxed, read-only investigation that answers a question against the context and ' +
        'codebase and returns a findings document — no code, no PR.',
      category: 'review',
      // The structured findings open in the shared generic viewer (no bespoke window).
      resultView: 'generic-structured',
    },
  },
]

/**
 * Register the spike kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerSpikeAgent(registry: AgentKindRegistry): void {
  registry.registerAll(SPIKE_AGENT_KINDS)
}

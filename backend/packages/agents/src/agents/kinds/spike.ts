import * as v from 'valibot'
import type { AgentRunContext, RepoOp } from '@cat-factory/kernel'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The built-in `spike` agent kind — a TIMEBOXED research/investigation task that
// produces a FINDINGS document, not code.
//
// A spike investigates a question against the given context (task description, linked
// docs/tasks, the codebase) and a set of criteria, then returns a structured assessment
// (question, findings, options compared, recommendation, open questions, confidence) with a
// mandatory prose `summary` body. It is a read-only `container-explore` kind (like
// `bug-investigator` / the `security-auditor` worked example): the container makes no edits,
// opens no PR, and the mechanical render of the findings to `docs/research/<slug>.md` is the
// deterministic backend {@link spikePostOp} over the checkout-free {@link RepoFiles} port —
// committed straight onto the base branch (no PR), the way the `blueprints` post-op commits.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for a
// registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`); the
// spike's per-task research criteria + time-box are folded into the user prompt by
// {@link spikeContextSection} (wired into the generic block-context prompt in `catalog.ts`),
// so the prompt below is only the core role.
// ---------------------------------------------------------------------------

export const SPIKE_AGENT_KIND = 'spike'

/** Fallback location for the committed findings when the task pins no `targetPath`. */
const SPIKE_FINDINGS_DIR = 'docs/research'

/**
 * The spike's structured findings. Lenient (`v.fallback`/`v.optional`) exactly like
 * `securityAssessment`/`bugInvestigation` so a partially-malformed reply degrades to sensible
 * defaults rather than failing the whole run — one noisy field can't discard the object, and a
 * present-but-invalid value degrades to its default. The prose `summary` is the human-readable
 * body (D2 in the spike tracker: structured fields PLUS a mandatory prose body — both surfaces
 * work), the rest drive the `generic-structured` result view and the rendered document.
 */
export const spikeFindings = defineStructuredOutput(
  v.object({
    /** The question or hypothesis the spike investigated, restated in the agent's words. */
    question: v.fallback(v.optional(v.string()), undefined),
    /** The prose findings body — the readable digest surfaced in the UI + rendered document. */
    summary: v.fallback(v.optional(v.string()), undefined),
    /** Individual findings, each a short title + optional detail. */
    findings: v.fallback(
      v.array(
        v.fallback(
          v.object({
            title: v.fallback(v.string(), 'Untitled finding'),
            detail: v.fallback(v.optional(v.string()), undefined),
          }),
          { title: 'Untitled finding' },
        ),
      ),
      [],
    ),
    /** Each option weighed, with the assessment that favoured / discounted it. */
    optionsCompared: v.fallback(
      v.array(
        v.fallback(
          v.object({
            option: v.fallback(v.string(), ''),
            assessment: v.fallback(v.optional(v.string()), undefined),
          }),
          { option: '' },
        ),
      ),
      [],
    ),
    /** The recommendation the evidence supports; omitted when the spike is inconclusive. */
    recommendation: v.fallback(v.optional(v.string()), undefined),
    /** What remains unresolved / deliberately not chased within the time-box. */
    openQuestions: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** Confidence in the recommendation, 0..1; out-of-range/non-numeric ⇒ omitted. */
    confidence: v.fallback(v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))), undefined),
  }),
)

export type SpikeFindings = ReturnType<typeof spikeFindings.parse>

const SPIKE_SYSTEM_PROMPT =
  'You are a senior engineer running a TIMEBOXED SPIKE — a research/investigation task whose ' +
  'sole deliverable is a findings document, NOT a code change. Investigate the question against ' +
  'the provided context (the task description, any linked documents or tasks) and the codebase ' +
  '(read-only), weigh the options where options exist, and reach a recommendation ONLY when the ' +
  'evidence supports one. Size the depth of your investigation to the stated time-box: prefer ' +
  'breadth first, then depth on what matters most, and be explicit about what you deliberately ' +
  'did not chase. Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "question": "the question you investigated, restated with the context you found",\n' +
  '  "summary": "a prose findings body — the readable narrative of what you learned",\n' +
  '  "findings": [{ "title": "short finding", "detail": "the evidence behind it" }],\n' +
  '  "optionsCompared": [{ "option": "name", "assessment": "why it fits / falls short" }],\n' +
  '  "recommendation": "the direction the evidence supports (omit if inconclusive)",\n' +
  '  "openQuestions": ["what remains unresolved or out of scope for this time-box"],\n' +
  '  "confidence": 0.0\n' +
  '}\n' +
  'Always fill "summary" — it is the human-readable body of the findings. Ground every finding ' +
  'in concrete evidence from the context or codebase; do not speculate. Leave "optionsCompared" ' +
  'empty when the task is not a comparison. Do not write, propose, or commit any code change.'

/** A safe lower-kebab slug for the findings filename, mirroring the render helpers' `moduleSlug`. */
function spikeSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '') || 'spike'
  )
}

/** The repo path the findings are committed to — the task's pinned `targetPath`, else a slug. */
function spikeFindingsPath(context: AgentRunContext): string {
  const pinned = context.block.taskTypeFields?.targetPath?.trim()
  if (pinned) return pinned
  return `${SPIKE_FINDINGS_DIR}/${spikeSlug(context.block.title)}.md`
}

/** Render the findings to deterministic Markdown — pure (same input → same bytes). */
export function renderSpikeFindings(findings: SpikeFindings, title: string): string {
  const lines: string[] = [`# Spike: ${title}`, '']
  if (findings.question) lines.push('## Question', '', findings.question, '')
  if (findings.summary) lines.push('## Findings', '', findings.summary, '')
  if (findings.findings.length) {
    lines.push('## Key findings', '')
    for (const f of findings.findings) {
      lines.push(`- **${f.title}**`)
      if (f.detail) lines.push(`  ${f.detail}`)
    }
    lines.push('')
  }
  if (findings.optionsCompared.length) {
    lines.push('## Options compared', '')
    for (const o of findings.optionsCompared) {
      if (!o.option) continue
      lines.push(`- **${o.option}**${o.assessment ? `: ${o.assessment}` : ''}`)
    }
    lines.push('')
  }
  if (findings.recommendation) {
    lines.push('## Recommendation', '', findings.recommendation, '')
    if (findings.confidence !== undefined) {
      lines.push(`_Confidence: ${(findings.confidence * 100).toFixed(0)}%_`, '')
    }
  }
  if (findings.openQuestions.length) {
    lines.push('## Open questions', '')
    for (const q of findings.openQuestions) if (q) lines.push(`- ${q}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * POST-OP for the `spike` kind: render the structured findings to `docs/research/<slug>.md`
 * (or the task's pinned `targetPath`) and commit them onto the run's branch — the base branch,
 * since the kind clones `base` and opens no PR (see `resolveRepoOpBranch`'s `base` arm). The
 * deterministic render lives here in plain backend TypeScript over the checkout-free
 * {@link RepoFiles}, exactly like the `blueprints`/`security-auditor` post-ops.
 *
 * IDEMPOTENT (byte-identical guard) so a durable-driver replay never double-commits, and a
 * no-op when the agent returned nothing parseable (a malformed run commits no empty report).
 * When no repo is resolvable (GitHub unwired, or a docs-only spike under an unlinked service)
 * the engine skips the whole hook before this runs, so the findings still settle on
 * `step.custom` — the commit is a best-effort durable copy, not a precondition for success.
 */
export const spikePostOp: RepoOp = async (ctx) => {
  const findings = spikeFindings.safeParse(ctx.result?.custom)
  if (!findings) return
  const path = spikeFindingsPath(ctx.context)
  const content = renderSpikeFindings(findings, ctx.context.block.title)
  const existing = await ctx.repo.getFile(path, ctx.branch)
  if (existing?.content === content) return
  await ctx.repo.commitFiles({
    branch: ctx.branch,
    message: 'docs(research): update spike findings',
    files: [{ path, content }],
  })
}

/**
 * The spike's per-task research criteria + time-box, folded into the user prompt. Only rendered
 * for the `spike` kind (gated by the caller in `catalog.ts`), reading the fields the create form
 * collected into `taskTypeFields`. Empty when a spike carries none — so the section is additive.
 */
export function spikeContextSection(context: AgentRunContext): string | undefined {
  const fields = context.block.taskTypeFields
  if (!fields) return undefined
  const lines: string[] = []
  if (typeof fields.timeboxHours === 'number' && Number.isFinite(fields.timeboxHours)) {
    lines.push(
      `- Time-box: ~${fields.timeboxHours} hour(s) — size the investigation to this budget; ` +
        'prefer breadth first, then depth on what matters most, and list what you deliberately ' +
        'did not chase.',
    )
  }
  const question = fields.researchQuestion?.trim()
  if (question) lines.push(`- Research question: ${question}`)
  const criteria = fields.successCriteria?.trim()
  if (criteria) lines.push(`- Success criteria / decision sought: ${criteria}`)
  const options = fields.optionsToCompare?.trim()
  if (options) lines.push(`- Options to compare: ${options}`)
  if (!lines.length) return undefined
  return ['Spike investigation parameters:', ...lines].join('\n')
}

export const SPIKE_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: SPIKE_AGENT_KIND,
    systemPrompt: SPIKE_SYSTEM_PROMPT,
    // Read-only checkout of the primary repo's base branch; `agent.output` is derived from the
    // schema. The findings render + commit is the backend post-op above (base branch, no PR).
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: spikeFindings,
    postOps: [spikePostOp],
    presentation: {
      label: 'Spike',
      icon: 'i-lucide-flask-conical',
      color: '#22d3ee',
      description:
        'Timeboxed read-only investigation that answers a research question against the context ' +
        'and codebase, and commits a findings document (no code, no PR).',
      category: 'design',
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

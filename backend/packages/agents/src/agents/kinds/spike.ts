import * as v from 'valibot'
import type { AgentRunContext, RepoOp, RepoOpContext, RepoOpResult } from '@cat-factory/kernel'
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
// `bug-investigator` / the `security-auditor` worked example): the CONTAINER makes no edits and
// opens no PR. The mechanical render of the findings to `docs/research/<slug>.md` is the
// deterministic backend {@link spikePostOp} over the checkout-free {@link RepoFiles} port, which
// DELIVERS them per the pipeline (see `RepoOpContext.opensPr`): the default `pl_spike` commits to
// a work branch and opens a PR (reviewed + merged by the `conflicts → ci → human-review → merger`
// tail, so protected base branches are respected), while `pl_spike_direct` commits straight onto
// the base branch (best-effort, no PR), the way the `blueprints` post-op commits.
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
  // The findings ARE the deliverable — fail the run loudly when the model returns an EMPTY /
  // truncated final answer (a common reasoning-model failure) instead of laundering it through
  // repair into an empty findings object that would render a title-only document. Mirrors
  // `environment-analyst`, whose deliverable is likewise the structured JSON.
  { failOnUnusableFinal: true },
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

/**
 * Whether the findings carry any substantive content worth committing. A reply that parsed
 * (the lenient `v.fallback` schema succeeds even on `{}`) but is otherwise empty would render
 * a title-only document; guarding on this keeps the post-op's "commits no empty report"
 * contract honest — a degenerate empty object writes nothing.
 */
function spikeHasRenderableFindings(findings: SpikeFindings): boolean {
  return Boolean(
    findings.question?.trim() ||
    findings.summary?.trim() ||
    findings.recommendation?.trim() ||
    findings.findings.length ||
    findings.optionsCompared.some((o) => o.option) ||
    findings.openQuestions.some((q) => q),
  )
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

/** The per-block work branch a PR-delivered spike commits its findings to (then PRs to base). */
function spikeWorkBranch(context: AgentRunContext): string {
  return `cat-factory/${context.block.id}`
}

const SPIKE_COMMIT_MESSAGE = 'docs(research): update spike findings'

/**
 * POST-OP for the `spike` kind: render the structured findings to `docs/research/<slug>.md`
 * (or the task's pinned `targetPath`) and DELIVER them to the repo. The deterministic render
 * lives here in plain backend TypeScript over the checkout-free {@link RepoFiles}, exactly like
 * the `blueprints`/`security-auditor` post-ops. Delivery follows the pipeline (via
 * `ctx.opensPr`, derived by the engine from the run's steps — no per-task flag to drift):
 *
 *  - **PR mode** (`ctx.opensPr`, the default `pl_spike` pipeline with a merge tail): commit the
 *    findings to a per-block WORK branch and open a pull request onto the base branch, returning
 *    its {@link RepoOpResult.pullRequest} so the engine records `block.pullRequest` and the
 *    downstream `conflicts → ci → human-review → merger` tail reviews + merges it. A failure here
 *    IS fatal — the whole point of this mode is the PR, and the work branch isn't protected, so a
 *    failed open is a real error worth surfacing (see {@link deliverSpikeViaPullRequest}).
 *  - **Direct mode** (`pl_spike_direct`, no merge tail): commit straight onto the base branch,
 *    BEST-EFFORT — the findings already live on `step.custom` (the UI's source of truth), so a
 *    rejected write (a protected base branch, a token without push) must NOT discard an
 *    otherwise-successful investigation; the failure is swallowed.
 *
 * IDEMPOTENT (byte-identical guard) so a durable-driver replay never double-commits, and a
 * no-op when the agent returned nothing parseable OR a present-but-empty object (a malformed
 * run commits no empty report — see {@link spikeHasRenderableFindings}). The repo-less case (no
 * repo resolvable — GitHub unwired, or a docs-only spike under an unlinked service) is handled a
 * layer up: the engine skips the whole hook before this runs.
 */
export const spikePostOp: RepoOp = async (ctx) => {
  const findings = spikeFindings.safeParse(ctx.result?.custom)
  if (!findings || !spikeHasRenderableFindings(findings)) return
  const path = spikeFindingsPath(ctx.context)
  const content = renderSpikeFindings(findings, ctx.context.block.title)
  if (ctx.opensPr) return deliverSpikeViaPullRequest(ctx, path, content)
  // Direct mode: commit straight onto the base branch (`ctx.branch`), best-effort.
  try {
    const existing = await ctx.repo.getFile(path, ctx.branch)
    if (existing?.content === content) return
    await ctx.repo.commitFiles({
      branch: ctx.branch,
      message: SPIKE_COMMIT_MESSAGE,
      files: [{ path, content }],
    })
  } catch {
    // Best-effort: the findings survive on `step.custom`, so a rejected repo interaction
    // (protected branch / missing push permission / transient API failure) leaves the spike
    // `done` with its findings intact rather than failing the run over the durable copy.
  }
}

/**
 * PR-mode delivery: ensure the per-block work branch off base, commit the findings idempotently,
 * and open (or reuse) a PR onto the base branch. `ctx.branch` is the base branch (the kind clones
 * `base`), so it is the PR's target. Returns the opened PR for the engine to record. Not
 * best-effort: a commit/PR failure fails the step — the pipeline's whole reason to be here is the
 * PR, and a work branch is unprotected, so a failure is a genuine error. An empty repo (no base
 * head) can have no PR, so it falls back to a direct base commit.
 */
async function deliverSpikeViaPullRequest(
  ctx: RepoOpContext,
  path: string,
  content: string,
): Promise<RepoOpResult | undefined> {
  const base = ctx.branch
  const workBranch = spikeWorkBranch(ctx.context)
  if (!(await ctx.repo.headSha(workBranch))) {
    const baseSha = await ctx.repo.headSha(base)
    if (!baseSha) {
      // Empty repo: nothing to branch from / PR against — commit onto base and skip the PR.
      await ctx.repo.commitFiles({
        branch: base,
        message: SPIKE_COMMIT_MESSAGE,
        files: [{ path, content }],
      })
      return
    }
    await ctx.repo.createBranch(workBranch, baseSha)
  }
  const existing = await ctx.repo.getFile(path, workBranch)
  if (existing?.content !== content) {
    await ctx.repo.commitFiles({
      branch: workBranch,
      message: SPIKE_COMMIT_MESSAGE,
      files: [{ path, content }],
    })
  }
  const pr = await ctx.repo.openPullRequest({
    title: `Spike findings: ${ctx.context.block.title}`,
    head: workBranch,
    base,
    body:
      'Automated spike findings document. Review the rendered research below; ' +
      'request changes with review comments (the fixer will amend this branch).',
  })
  return { pullRequest: { url: pr.url, number: pr.number, branch: workBranch } }
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
    // schema. The findings render + delivery is the backend post-op above (a PR by default, or a
    // direct base commit for `pl_spike_direct`).
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: spikeFindings,
    postOps: [spikePostOp],
    presentation: {
      label: 'Spike',
      icon: 'i-lucide-flask-conical',
      color: '#22d3ee',
      description:
        'Timeboxed read-only investigation that answers a research question against the context ' +
        'and codebase, and delivers a findings document (as a pull request by default; no code).',
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

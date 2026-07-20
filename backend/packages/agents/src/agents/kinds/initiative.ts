import type { AgentRunContext } from '@cat-factory/kernel'
import { INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND } from '@cat-factory/kernel'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `initiative-breakdown` agent kind — the first agent reachable from the PUBLIC API.
//
// An external system posts an initiative brief to `POST /api/v1/initiatives`; the engine runs
// this single INLINE step (one-shot LLM, no checkout, no repo, no push) and persists the result
// to the DB for asynchronous retrieval. Its deliverable IS its reply — a structured breakdown of
// the initiative into services / modules / candidate tasks — so it is a FORWARD-planning kind
// (decompose a brief), the mirror of the reverse `blueprints` kind (describe existing code, which
// needs a container + repo). Registered through the same public `registerAgentKind` seam the
// document kinds use, so it is a first-class kind with no bespoke harness handler.
// ---------------------------------------------------------------------------

export const INITIATIVE_BREAKDOWN_KIND = 'initiative-breakdown'

const INITIATIVE_BREAKDOWN_SYSTEM_PROMPT =
  'You are a senior delivery lead breaking a high-level initiative down into an actionable plan. ' +
  'Given the initiative brief, produce a clear, hierarchical decomposition an engineering team ' +
  'could pick up: the SERVICES or areas involved, the MODULES within each, and the concrete ' +
  'candidate TASKS under those modules. For each task give a short imperative title and a ' +
  'one-line description of the work and its intent. Call out cross-cutting concerns, sequencing / ' +
  'dependencies between tasks, key risks, and any open questions or assumptions you had to make. ' +
  'Do NOT write code, do not attempt to access a repository — reason purely from the brief and ' +
  'any linked context. Respond with a well-structured Markdown document: a short overview first, ' +
  'then the service → module → task hierarchy, then risks and open questions.'

function initiativeBreakdownUserPrompt(context: AgentRunContext): string {
  const brief = context.block.description?.trim()
  return [
    `Initiative: ${context.block.title}`,
    '',
    'Brief / requirements:',
    brief || '(none provided — infer a reasonable breakdown from the title)',
    '',
    'Produce the initiative breakdown as described.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The container initiative-planning kinds — `initiative-analyst` + `initiative-planner`.
//
// Both explore a real (read-only) checkout of the initiative's repo, so they run in a
// container. They were the last built-in container kinds still rendered by the bespoke
// `buildMigratedBuiltInBody` switch in `@cat-factory/server`; migrating them onto the
// public `registerAgentKind` seam (the refactoring-candidates.md #5 strangler) is what
// lets that switch shed its cases. Their kind ids live in `@cat-factory/kernel`, so the
// definitions (prompts + user-prompt builders) live here in the agents package alongside
// every other registered kind — the generic `agentStep`-driven dispatch path in the server
// builds their job body from the declared `agent` spec, and `systemPromptFor` supplies the
// role prompt + the surface-driven directives (READ_ONLY_GUARDRAIL / FINAL_ANSWER_IN_REPLY),
// so the constants below deliberately do NOT restate the final-answer directive.
// ---------------------------------------------------------------------------

/** Role prompt the initiative-analyst step runs under (returns a prose codebase analysis). */
const INITIATIVE_ANALYST_SYSTEM_PROMPT =
  'You are a staff engineer performing a CODEBASE ANALYSIS to ground the planning of a ' +
  'long-running initiative (a cross-cutting refactor, a migration, a strangler conversion). ' +
  'Explore the repository and produce a concise, concrete analysis a planner will use to ' +
  'decompose the work: the relevant architecture and module boundaries, the files/areas the ' +
  'initiative will most likely touch, existing patterns to follow, cross-cutting concerns, ' +
  'risks and likely sequencing constraints. Ground every claim in real file/directory ' +
  'references; do NOT propose the plan itself (no phases/items) and do NOT modify anything. ' +
  'Respond with a clear Markdown analysis.'

/** Role prompt the initiative-planner step's agent runs under (returns the plan as JSON). */
const INITIATIVE_PLANNER_SYSTEM_PROMPT =
  'You are a staff engineer planning a LONG-RUNNING INITIATIVE — a body of work too ' +
  'large for one task (a cross-cutting refactor, a migration, a strangler conversion). ' +
  'Explore the repository first and ground every part of the plan in the actual code. ' +
  'Decompose the initiative into SEQUENTIAL PHASES, each holding concrete work ITEMS: ' +
  'an item must be a self-sufficient task one coding agent can complete in a single PR, ' +
  'with a description that stands alone (name the files/modules it touches). Give every ' +
  'item an estimate — complexity, risk and impact, each 0..1 — and declare `dependsOn` ' +
  '(item ids) only where an item genuinely needs another item merged first; independent ' +
  'items in a phase may run in parallel. Choose an execution policy: `maxConcurrent` ' +
  '(how many items may run at once — 1 for delicate serialized work) and ordered ' +
  '`rules` mapping estimates to pipelines (an item matches a rule when ANY axis meets ' +
  'its `min*` threshold; first match wins; no match falls back to `defaultPipelineId`). ' +
  'Available pipelines: `pl_quick` (small, low-risk change), `pl_simple` (standard ' +
  'change, lighter review), `pl_full` (full spec/review/test rigor), `pl_bugfix` (bug ' +
  'remediation). Record the decisions you made and any known caveats. ' +
  'Respond with ONLY a JSON object of shape {"goal","constraints":[],"nonGoals":[],' +
  '"analysisSummary","phases":[{"id","title","goal","maxConcurrent"?}],' +
  '"items":[{"id","phaseId","title","description","dependsOn":[],' +
  '"estimate":{"complexity","risk","impact","rationale"},"pipelineId"?}],' +
  '"policy":{"maxConcurrent","rules":[{"pipelineId","minComplexity"?,"minRisk"?,' +
  '"minImpact"?}],"defaultPipelineId"},"decisions":[{"title","detail"}],"caveats":[]} ' +
  '— no prose, no code fences.'

/** Compact shape hint fed to the structured-output repair call for the initiative plan. */
const INITIATIVE_PLAN_SHAPE_HINT =
  'Expected an initiative plan: {"goal": string, "constraints": string[], "nonGoals": ' +
  'string[], "analysisSummary": string, "phases": [{"id": string, "title": string, ' +
  '"goal": string}], "items": [{"id": string, "phaseId": string, "title": string, ' +
  '"description": string, "dependsOn": string[], "estimate": {"complexity": number 0..1, ' +
  '"risk": number 0..1, "impact": number 0..1, "rationale": string}}], "policy": ' +
  '{"maxConcurrent": number, "rules": [{"pipelineId": string, "minComplexity"?: number, ' +
  '"minRisk"?: number, "minImpact"?: number}], "defaultPipelineId": string}, ' +
  '"decisions": [{"title": string, "detail": string}], "caveats": string[]}.'

/**
 * Render the generic "required plan shape" section a preset's declarative {@link
 * InitiativePresetPhaseTemplate} dictates (slice T1): the phase ids VERBATIM, titles, goals and
 * order, plus whether the planner may add extra phases. Pure + generic — it never branches on a
 * preset id, so a preset with no template contributes nothing and the free-form planner prompt is
 * byte-for-byte unchanged. Folded into the PLANNER prompt only (the planner authors the phases;
 * the ingest normalizer then enforces this shape).
 */
function planShapeLines(template: InitiativePresetPhaseTemplate): string[] {
  const lines = [
    '',
    '## Required plan shape',
    '',
    'This preset runs a fixed multi-phase methodology. Build the plan around these phases, in ' +
      'this order, using each phase `id` VERBATIM:',
    '',
  ]
  let hasOptional = false
  template.phases.forEach((phase, i) => {
    const isOptional = phase.required !== true
    if (isOptional) hasOptional = true
    lines.push(`${i + 1}. \`${phase.id}\` — ${phase.title}${isOptional ? ' (optional)' : ''}`)
    if (phase.goal?.trim()) lines.push(`   ${phase.goal.trim()}`)
  })
  lines.push('')
  // Fidelity of whatever phases you DO include is non-negotiable, independent of the extra-phase
  // policy below.
  lines.push(
    'For every phase you include, use its `id` VERBATIM and keep this order — do NOT rename, ' +
      'reorder or merge phases.',
  )
  // Presence: required phases are mandatory; optional ones may be omitted. Only draw the
  // distinction when the template actually has an optional phase, so an all-required template
  // reads as a flat "every phase must be present" with no confusing "(optional)" carve-out.
  lines.push(
    hasOptional
      ? 'Every phase NOT marked (optional) must be present; you may omit an (optional) phase when ' +
          'the work does not need it.'
      : 'Every phase above must be present.',
  )
  // Extra-phase policy — the ONE knob `allowAdditionalPhases` governs.
  lines.push(
    template.allowAdditionalPhases
      ? 'You MAY append further phases after these when the work needs them.'
      : 'Do NOT introduce any phase beyond this set — it is otherwise exhaustive.',
  )
  return lines
}

/**
 * Render the planning context an initiative-level run carries (slice 2): the interviewer's
 * synthesized goal / constraints / non-goals + the Q&A digest, and the analyst's codebase
 * analysis. Folded into the analyst and planner prompts so each is grounded in the human's
 * intent and the prior step's findings. Returns [] when no initiative context is present
 * (e.g. the interviewer/analyst passed through with no model wired).
 */
function initiativeContextLines(
  context: AgentRunContext,
  opts: { includeAnalysis: boolean; includePlanShape: boolean },
): string[] {
  const init = context.initiative
  if (!init) return []
  const lines: string[] = []
  // NOTE: preset steering (the `initiativePresetSection` `promptAddition`) is deliberately NOT
  // rendered here. These builders now resolve through `userPromptFor` → `buildBaseUserPrompt`
  // (catalog.ts), which prepends `initiativePresetSection` to EVERY registered kind's own prompt —
  // so rendering it here too would emit the section twice. The generic prepend is the single owner
  // of preset steering (it frames the step's role FIRST, for a custom kind and these built-ins
  // alike); this function contributes only the initiative-specific context below.
  // The required plan shape (planner only): a preset's declarative phase template, rendered so the
  // planner emits exactly the mandated phases. No template ⇒ nothing added.
  if (opts.includePlanShape && init.preset?.phaseTemplate) {
    lines.push(...planShapeLines(init.preset.phaseTemplate))
  }
  if (init.goal?.trim()) lines.push('', '## Agreed goal', '', init.goal.trim())
  if (init.constraints?.length) {
    lines.push('', '## Constraints', '', ...init.constraints.map((c) => `- ${c}`))
  }
  if (init.nonGoals?.length) {
    lines.push('', '## Non-goals', '', ...init.nonGoals.map((c) => `- ${c}`))
  }
  const qa = (init.qa ?? []).filter((q) => q.answer?.trim())
  if (qa.length) {
    lines.push('', '## Planning interview', '')
    for (const { question, answer } of qa) lines.push(`- Q: ${question}`, `  A: ${answer}`)
  }
  if (opts.includeAnalysis && init.analysisSummary?.trim()) {
    lines.push('', '## Codebase analysis', '', init.analysisSummary.trim())
  }
  return lines
}

/**
 * The initiative-analyst's task prompt: the agreed goal / constraints from the interview
 * plus the instruction to analyse the repo. The backend's analyst post-completion resolver
 * folds the returned prose onto the `initiatives` entity (`analysisSummary`), which the
 * planner then consumes.
 */
export function initiativeAnalystUserPrompt(context: AgentRunContext): string {
  const block = context.block
  const description = block.description?.trim()
  return [
    `Analyse this codebase to ground planning of the initiative: ${
      block.title || '(untitled initiative)'
    }`,
    ...(description ? ['', description] : []),
    ...initiativeContextLines(context, { includeAnalysis: false, includePlanShape: false }),
    '',
    'Explore the repository and produce the analysis described in your instructions — ' +
      'architecture, likely touch points, patterns to follow, risks and sequencing. ' +
      'Respond with a clear Markdown analysis.',
  ].join('\n')
}

/**
 * The initiative-planner's task prompt: the human's rough goal statement (the
 * initiative block's title + description), the interview + codebase-analysis context the
 * interviewer/analyst steps produced (slice 2), plus the exploration/plan instructions.
 * The agent reads the codebase from its own read-only checkout; the backend ingests the
 * returned plan into the `initiatives` entity, and the committer step renders + commits the
 * in-repo tracker after the human approves the plan.
 */
export function initiativePlannerUserPrompt(context: AgentRunContext): string {
  const block = context.block
  const description = block.description?.trim()
  return [
    `Plan the initiative: ${block.title || '(untitled initiative)'}`,
    ...(description ? ['', description] : []),
    ...initiativeContextLines(context, { includeAnalysis: true, includePlanShape: true }),
    '',
    'Explore this repository to ground the plan in the real code (building on the codebase ' +
      'analysis above), honour the agreed goal / constraints / non-goals, then produce the ' +
      'complete multi-phase plan: sequential phases, self-sufficient items with ' +
      'estimates and dependencies, and the execution policy (concurrency + ' +
      'estimate→pipeline rules).',
    '',
    'Respond with ONLY the JSON object for the plan — no prose, no code fences.',
  ].join('\n')
}

export const INITIATIVE_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: INITIATIVE_BREAKDOWN_KIND,
    systemPrompt: INITIATIVE_BREAKDOWN_SYSTEM_PROMPT,
    userPrompt: initiativeBreakdownUserPrompt,
    agent: { surface: 'inline' },
    presentation: {
      label: 'Initiative Breakdown',
      icon: 'i-lucide-list-tree',
      color: '#34d399',
      description:
        'Decomposes a high-level initiative brief into a service → module → task plan. Runs inline (no repo), the entry agent for the public API.',
      category: 'design',
    },
  },
  // The initiative-analyst reads the repository (read-only, base branch — an initiative block has
  // no PR) and returns a PROSE codebase-analysis report grounding the plan. Its output is folded
  // onto the `initiatives` entity by the engine's analyst post-completion resolver and then into
  // the planner's prompt. No structured output — it makes no commit and opens no PR (an edit-free
  // run is the expected outcome). No `presentation`: it is a pipeline-internal step, not a
  // user-draggable palette kind, so it stays out of the `customAgentKinds` snapshot.
  {
    kind: INITIATIVE_ANALYST_AGENT_KIND,
    systemPrompt: INITIATIVE_ANALYST_SYSTEM_PROMPT,
    userPrompt: initiativeAnalystUserPrompt,
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    // Reads the code to produce a codebase-analysis report (architect-like), so the engine folds
    // the service's best-practice fragments into its prompt.
    traits: [CODE_AWARE_TRAIT],
  },
  // The initiative-planner reads the repository (read-only, base branch) to ground its multi-phase
  // plan in the actual code, returning ONLY the plan as JSON. `toRunResult` coerces it into
  // `initiativePlan` for the engine's ingest (into the `initiatives` entity); the in-repo tracker
  // is committed later by the `initiative-committer` step, AFTER the human approves the plan at the
  // pipeline gate. `failOnUnusableFinal` because the plan is handed onward — a truncated final
  // answer must fail loudly, not be laundered into a half-baked plan by the structured repair.
  {
    kind: INITIATIVE_PLANNER_AGENT_KIND,
    systemPrompt: INITIATIVE_PLANNER_SYSTEM_PROMPT,
    userPrompt: initiativePlannerUserPrompt,
    // Reads the code to ground its multi-phase plan (architect-like), so the engine folds the
    // service's best-practice fragments into its prompt.
    traits: [CODE_AWARE_TRAIT],
    agent: {
      surface: 'container-explore',
      clone: { branch: 'base' },
      output: {
        kind: 'structured',
        shapeHint: INITIATIVE_PLAN_SHAPE_HINT,
        failOnUnusableFinal: true,
      },
    },
  },
]

/**
 * Register the initiative kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerInitiativeAgents(registry: AgentKindRegistry): void {
  registry.registerAll(INITIATIVE_AGENT_KINDS)
}

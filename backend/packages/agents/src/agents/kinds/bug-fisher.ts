import { type BugFishingPhaseDescriptor, bugFishingAgentOutputSchema } from '@cat-factory/contracts'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `bug-fisher` agent kind — the read-only, multi-angle hunt for latent defects in an
// EXISTING codebase (the "bug fishing expedition").
//
// It is a `container-explore` (read-only) clone of the service's base branch, and it is
// dispatched ONCE PER ANGLE by the engine's phase loop rather than once per run. Each
// dispatch is a fresh context reading the same tree with a different question, which is the
// whole design: a single pass told to "find bugs" returns the shallow half of everything,
// whereas a pass told to think only about concurrency reads the same files with a question
// that makes the race visible. The angle catalog lives in `@cat-factory/contracts`
// (`BUG_FISHING_PHASES`) because both the SPA (the create form's angle picker, the window's
// phase headers) and the engine (this prompt) have to agree about it.
//
// The per-dispatch phase brief is injected by the engine as a prior output (the same
// injection point the Challenge Investigator's brief uses), NOT baked into the system prompt:
// the prompt below is the standing role, which is what lets a workspace override it without
// losing the angle it is currently fishing.
//
// Its structured output is ONE PHASE's findings. The engine mints ids, stamps them with the
// phase, appends them to `step.bugFishing`, and either re-arms this step for the next angle
// or parks the run for triage. Findings are NEVER acted on by this kind: a human marks the
// ones worth fixing and each spawns its own bug-fix task on its own pipeline.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for a
// registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`), so the
// prompt below is only the core role.
// ---------------------------------------------------------------------------

export const BUG_FISHER_KIND = 'bug-fisher'

/**
 * One phase's structured catch. The lenient (`v.fallback`) shape is the SINGLE source of truth
 * in `@cat-factory/contracts` (`bugFishingAgentOutputSchema`) — shared with the engine's
 * coercion onto `step.bugFishing` and the triage UI — so a partially-malformed reply degrades
 * to sensible defaults rather than throwing away a pass whose other findings are fine.
 */
export const bugFishing = defineStructuredOutput(bugFishingAgentOutputSchema)

export type BugFishingOutput = ReturnType<typeof bugFishing.parse>

/**
 * How the fisher must spend its context. Same constraint as the PR reviewer's, for the same
 * reason: an agentic loop re-sends its whole transcript every turn, so a file read into context
 * early is paid for again on every later turn. An expedition is worse off than a review, since
 * it has no diff to bound it — the whole repository is in scope — which is exactly why the
 * angle is what narrows the reading rather than a file list.
 */
const CONTEXT_DISCIPLINE = `
Everything you read stays in your context for the rest of this pass and is re-sent on every later
turn, so a large file read early costs many times what it looks like. Work accordingly:
- Start from structure, not bodies: the directory layout, entry points, and \`grep -n\` for the
  shapes this angle is about. Read a body only once something points you at it.
- Read RANGES, not whole files (\`sed -n '120,260p'\`, \`grep -n -C5 <pattern>\`).
- Never re-read something you already read — it is still in your context.
- When a lead needs deep reading, dispatch a subagent for it: its reading lands on its context,
  not yours. Give each one a turn budget and ask for its findings as JSON.
- Depth beats breadth here. Three findings you can point at beat twenty you cannot.`

/**
 * What makes a finding worth reporting. This is the part of the prompt that decides whether an
 * expedition is useful or noise: an agent asked to find bugs in a healthy codebase will find
 * something, and the something is invariably a style opinion dressed as a defect.
 *
 * So the bar is stated as a test the agent applies to each candidate before reporting it, and
 * the honest empty answer is named as an acceptable outcome. `confidence` exists for the same
 * reason: a finding the agent is unsure of is worth surfacing when it says so, and worthless
 * when it does not.
 */
const FINDING_BAR = `
Report a finding ONLY when you can name the concrete way it goes wrong: the input, the
interleaving, the state, or the requirement it violates. Apply this test to every candidate
before you report it:
- Can you point at the specific code that is wrong, by path and line? If not, do not report it.
- Can you describe what actually happens when it fires, in terms someone could reproduce or
  reason about? If it is only "this looks fragile", do not report it.
- Would fixing it change behaviour, or remove a real trap for the next maintainer? If it only
  changes how the code reads, do not report it. Style, naming, formatting, test-coverage
  opinions and "consider extracting this" are NOT findings.
- Have you checked whether something else already handles it? A guard one layer up, a database
  constraint, a type that makes the state unrepresentable, a caller that never passes that
  value. Read enough to know, and if you could not establish it, say so and set the finding's
  confidence to low rather than reporting it as certain.
Finding NOTHING under an angle is a legitimate and useful result. Say what you covered and why
you are satisfied, and return an empty findings list. Never pad a pass to look productive:
every false finding costs a human the triage and, if they believe it, a wasted fix task.`

export const BUG_FISHER_SYSTEM_PROMPT =
  'You are a senior engineer on a BUG FISHING EXPEDITION through an existing codebase. Nobody ' +
  'has reported a defect: your job is to find the ones nobody has hit yet — genuine gaps in the ' +
  'logic, real bugs, footguns, and edge cases the code does not handle — before a user does.\n' +
  'You are READ-ONLY. You never fix anything, never write to the repository, and never open a ' +
  'pull request. Your entire deliverable is the catch: what is wrong, where, and what happens ' +
  'because of it. A human then decides which findings become fix tasks.\n' +
  'This dispatch fishes ONE ANGLE, named in the phase brief you have been given. Stay on that ' +
  'angle. If you notice something that belongs to a different angle, leave it: another pass ' +
  'covers it, and a pass that wanders covers its own angle badly. The brief also lists the ' +
  'findings earlier passes already reported — do NOT report the same defect again, even phrased ' +
  'differently, and say so in your summary if an earlier finding turned out to be the root ' +
  'cause of something you were about to raise.\n' +
  'If product requirement, specification or rules documents were provided (task context ' +
  'documents, `.cat-context/` files, or in-repo specs the task points at), hold the code against ' +
  'them: they say what the code is SUPPOSED to do, and a disagreement between them and the code ' +
  'is a finding whichever side is wrong.\n' +
  CONTEXT_DISCIPLINE +
  '\n' +
  FINDING_BAR +
  '\n\nWork in this order:\n' +
  "1. Read the phase brief and the task's own focus. Decide where in this codebase that angle " +
  'could actually bite, and record that as a task list so the human can watch the pass.\n' +
  '2. Work those areas one at a time, reading narrowly (see the context discipline above).\n' +
  '3. For each candidate, apply the finding bar. Discard the ones that fail it.\n' +
  '4. Return what survived, ordered by severity.\n' +
  'Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "summary": "one paragraph: what you covered under this angle and what you concluded",\n' +
  '  "findings": [{\n' +
  '    "path": "repo/relative/path.ts",\n' +
  '    "line": 42,\n' +
  '    "severity": "critical | high | medium | low",\n' +
  '    "kind": "bug | logic-gap | edge-case | footgun | requirement-gap | other",\n' +
  '    "confidence": "high | medium | low",\n' +
  '    "title": "short headline",\n' +
  '    "detail": "what is wrong and what happens because of it, in prose",\n' +
  '    "failureScenario": "the concrete inputs / interleaving / state that make it fire",\n' +
  '    "evidence": "the code you read that supports the claim — quote or cite it",\n' +
  '    "suggestedFix": "a concrete suggested change, when you have one"\n' +
  '  }]\n' +
  '}\n' +
  'Severity is about CONSEQUENCE, not about how interesting the finding is: `critical` means ' +
  'data loss, a security hole, or a broken core path; `low` means a real but contained problem. ' +
  'Confidence is about how sure YOU are that it is real, and is yours to set honestly — a ' +
  'low-confidence finding that says so is useful, and a low-confidence finding reported as ' +
  'certain is worse than no finding at all.'

/**
 * Render the per-dispatch PHASE BRIEF the engine injects as a prior output: which angle this
 * pass fishes, what it is hunting, the task's own focus, and the findings earlier passes
 * already reported.
 *
 * Lives beside the kind rather than in the engine because it is prompt text about this kind's
 * contract, and it takes the DESCRIBED phase (never a bare id) so a run fishing an angle this
 * build has retired still briefs the agent with the title and goal it was planned under, rather
 * than with `undefined` (contracts' `describeBugFishingPhase` is what produces one).
 */
export function renderBugFishingPhaseBrief(input: {
  phase: BugFishingPhaseDescriptor
  /** 1-based position of this pass, and how many passes the expedition plans in total. */
  position: { index: number; total: number }
  /** The task's own focus (subsystems, directories, the defects that have been costing them). */
  focus?: string | null
  /** Titles of findings earlier passes already reported, so this one does not repeat them. */
  priorFindingTitles?: readonly string[]
}): string {
  const { phase, position, focus, priorFindingTitles } = input
  const lines = [
    `## Phase ${position.index} of ${position.total}: ${phase.title}`,
    '',
    `Goal: ${phase.goal}`,
  ]
  // A retired angle carries no focus text (there is no catalog entry left to take it from), and
  // an empty "What to look for" heading would read as an angle with nothing to look for.
  if (phase.focus) lines.push('', 'What to look for:', phase.focus)
  if (phase.retired) {
    lines.push(
      '',
      'NOTE: this angle was planned by an earlier version of the platform and is no longer part ' +
        'of the shipped expedition. Fish it as its goal above describes.',
    )
  }
  if (focus?.trim()) {
    lines.push(
      '',
      'The person who started this expedition asked you to concentrate on the following. It ' +
        'narrows WHERE you look; it does not change WHICH angle you are fishing:',
      focus.trim(),
    )
  }
  const prior = (priorFindingTitles ?? []).filter((t) => t.trim().length > 0)
  if (prior.length > 0) {
    lines.push(
      '',
      'Earlier phases of this expedition already reported the findings below. Do NOT report any ' +
        'of them again:',
      ...prior.map((title) => `- ${title}`),
    )
  } else {
    lines.push('', 'No earlier phase of this expedition has reported a finding yet.')
  }
  return lines.join('\n')
}

export const BUG_FISHER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: BUG_FISHER_KIND,
    systemPrompt: BUG_FISHER_SYSTEM_PROMPT,
    // Code-aware, so the engine folds the task's selected best-practice fragments into the
    // prompt: what "correct" means for this service is exactly what an expedition measures the
    // code against, and without the trait the task's chosen standards are silently dropped by
    // `AgentContextBuilder.resolveFragments`. Spec-aware for the requirements angle: the
    // committed specs are the other half of "what was this supposed to do".
    traits: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
    // Read-only FULL clone of the base branch. An expedition reads the codebase as it stands on
    // the default branch — there is no work branch, and nothing it does produces one. Full
    // history because several angles (lifecycle, concurrency, contracts) are answered by what a
    // line used to do, which a shallow clone cannot show.
    agent: { surface: 'container-explore', clone: { branch: 'base', full: true } },
    structuredOutput: bugFishing,
    presentation: {
      label: 'Bug Fisher',
      icon: 'i-lucide-fish',
      color: '#0ea5e9',
      description:
        'Read-only, multi-angle hunt through an existing codebase for genuine logic gaps, ' +
        'latent bugs, footguns and unhandled edge cases — one pass per angle, nothing changed.',
      category: 'review',
      // A hunt through code nobody reported a defect in: it belongs with the bug work rather
      // than with the build ladder, and with review because its product is findings.
      purposes: ['bugfix', 'review'],
      tier: 'intermediate',
      // Opens the dedicated expedition window (phases + findings + marking), not the generic
      // read-only JSON viewer. See BugFishingWindow.vue.
      resultView: 'bug-fishing',
    },
  },
]

/**
 * Register the bug-fisher kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerBugFisherAgent(registry: AgentKindRegistry): void {
  registry.registerAll(BUG_FISHER_AGENT_KINDS)
}

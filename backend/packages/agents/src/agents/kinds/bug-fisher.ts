import { type BugFishingPhaseDescriptor, bugFishingAgentOutputSchema } from '@cat-factory/contracts'
import { STANDARDS_AS_CONTEXT_FILES_GUIDANCE } from '../prompts/shared.js'
import { CONTEXT_DIR } from '../prompts/standard.js'
import { standardsAsContextFilesPreOp } from './pr-review-context.js'
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
 * The NAME the territory manifest is injected under, which is what `InjectedContextFile.path`
 * takes: the harness resolves every injected file inside the run's context directory and
 * `sanitizeContextFileName` strips any directory part it is handed. A path spelled with the
 * directory in it therefore landed correctly and was RECORDED wrong, so the context snapshot and
 * the run's own listing named `.cat-context/.cat-context/territory.md`.
 */
export const BUG_FISHING_TERRITORY_CONTEXT_FILE = 'territory.md'

/** Where the agent reads that manifest, and therefore the only spelling a prompt may use. */
export const BUG_FISHING_TERRITORY_CONTEXT_PATH = `${CONTEXT_DIR}/${BUG_FISHING_TERRITORY_CONTEXT_FILE}`

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
- Start from structure, not bodies. When \`${BUG_FISHING_TERRITORY_CONTEXT_PATH}\` is present it is
  that structure already handed to you: read it FIRST and let it point you at bodies, instead of
  spending turns on \`find\`, \`ls\` and three greps to rebuild it.
- Otherwise start from the directory layout, entry points, and \`grep -n\` for the shapes this
  angle is about. Read a body only once something points you at it.
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
  'covers it, and a pass that wanders covers its own angle badly. On a large codebase the brief ' +
  'ALSO names one TERRITORY: the slice of the codebase this pass owns. Read outside it freely ' +
  'when a neighbour answers "has something else already handled this?", but REPORT only findings ' +
  'whose code lies inside it. Another pass owns the rest, and a finding outside your territory ' +
  'is dropped rather than filed twice. The brief also lists the ' +
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
  '  "filesRead": ["every path you actually read during this pass, relative to your working ' +
  'directory"],\n' +
  '  "findings": [{\n' +
  '    "path": "path/relative/to/your/working/directory.ts",\n' +
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
  'Confidence is about how sure YOU are that it is real, and is yours to set honestly: a ' +
  'low-confidence finding that says so is useful, and a low-confidence finding reported as ' +
  'certain is worse than no finding at all.\n' +
  '`filesRead` is how the platform records what this expedition COVERED, so list every path you ' +
  'opened, including the ones you read and found nothing in. It is not a score and nothing ' +
  'judges you by its length: a short honest list plus an empty findings list says "this ' +
  'territory was sampled", which is what a human needs in order to know whether to run the ' +
  'angle again. Never list a file you did not open.\n' +
  'Every path you report, in `filesRead` and in a finding alike, is RELATIVE TO YOUR WORKING ' +
  'DIRECTORY, which for a service inside a monorepo is that service and not the repository root. ' +
  'The platform matches those paths against the territory it gave you, so a path in another ' +
  "frame reads as a file that is not in this pass's territory.\n" +
  STANDARDS_AS_CONTEXT_FILES_GUIDANCE

/**
 * Most territory roots a brief or a manifest header spells out before naming the remainder.
 *
 * A territory's roots are usually a directory or two, but the group of files sitting loose at a
 * root owns each of those files by path, and a flat repository has many. The brief is itself
 * context, so the list is bounded; the cap SAYS what it left out, because a reader who took the
 * list for the whole territory would treat the rest as somebody else's ground.
 */
const MAX_LISTED_ROOTS = 25

/** The roots a brief spells out, as bullets, plus a line naming any it did not. */
function listedRoots(roots: readonly string[]): string[] {
  const shown = roots.slice(0, MAX_LISTED_ROOTS).map((root) => `- \`${root}\``)
  if (roots.length <= MAX_LISTED_ROOTS) return shown
  return [
    ...shown,
    `- plus ${roots.length - MAX_LISTED_ROOTS} more paths this pass owns, not spelled out here.`,
  ]
}

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
  /**
   * The territory this pass owns, on a codebase large enough to have been partitioned. Absent ⇒
   * the pass fishes the whole codebase, which is what a small repository gets and what every
   * expedition got before territories existed.
   */
  territory?: { label: string; roots: readonly string[] } | null
}): string {
  const { phase, position, focus, priorFindingTitles, territory } = input
  const lines = [
    `## Phase ${position.index} of ${position.total}: ${phase.title}`,
    '',
    `Goal: ${phase.goal}`,
  ]
  if (territory) {
    lines.push(
      '',
      `Territory: ${territory.label}`,
      `This pass owns the paths below, and \`${BUG_FISHING_TERRITORY_CONTEXT_PATH}\` holds their shape. Read ` +
        'outside them whenever a neighbour tells you whether something is already handled, and ' +
        'report only findings whose own code lies inside them:',
      ...listedRoots(territory.roots),
    )
  }
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
      territory
        ? 'Earlier phases of this expedition already reported the findings below IN THIS ' +
            'TERRITORY. Do NOT report any of them again:'
        : 'Earlier phases of this expedition already reported the findings below. Do NOT report ' +
            'any of them again:',
      ...prior.map((title) => `- ${title}`),
    )
  } else {
    lines.push('', 'No earlier phase of this expedition has reported a finding yet.')
  }
  return lines.join('\n')
}

/**
 * Render the TERRITORY MANIFEST a pass is handed up front: the shape of the slice it owns, the
 * directories inside it with their file counts, and the territories it sits beside.
 *
 * This is where the token saving of the whole partition actually comes from, and it is
 * independent of how many passes run. Each angle is a fresh context by design, so without a
 * manifest every one of them re-discovers the layout, the entry points and the package boundaries
 * before it reads a body, and those discovery turns are re-sent on every later turn of the pass.
 * Handed the map, a pass's FIRST body read is its first turn.
 *
 * The manifest is itself context, so it is SIZED: directories with counts always, individual file
 * paths only while the list stays small. A map that costs a tenth of the budget it is meant to
 * save is not a map, and above the threshold the file list stays in the tree, which the pass can
 * `ls` on demand.
 */
export function renderBugFishingTerritoryContext(input: {
  territory: { label: string; roots: readonly string[]; approxTokens?: number }
  /** Every file of the territory, in the frame the agent works in (see the engine's survey). */
  files: readonly string[]
  /** The labels of the other territories this expedition fishes, so the pass knows its edges. */
  neighbours: readonly string[]
  /** Most individual paths to list before falling back to directory counts alone. */
  maxListedFiles?: number
}): string {
  const { territory, files, neighbours } = input
  const maxListed = input.maxListedFiles ?? 200
  const lines = [
    `# Territory: ${territory.label}`,
    '',
    'This is the slice of the codebase your pass owns. It was computed by the platform from the ',
    'repository tree, not by a model, so it is a fact about the code rather than a guess. Every ',
    'path below is relative to your working directory.',
    '',
    `- Files: ${files.length}`,
    `- Approximate size: ${territory.approxTokens ?? 0} tokens`,
    '',
    '## Roots',
    '',
    ...(territory.roots.length > 0 ? listedRoots(territory.roots) : ['- the whole codebase']),
    '',
    '## Directories',
    '',
  ]
  for (const [directory, count] of directoryCounts(files)) {
    lines.push(`- \`${directory}\` (${count} ${count === 1 ? 'file' : 'files'})`)
  }
  if (files.length <= maxListed) {
    lines.push('', '## Files', '', ...files.map((file) => `- \`${file}\``))
  } else {
    lines.push(
      '',
      `The full file list is ${files.length} paths, too long to hand over without spending the ` +
        'context this map exists to save. The directory counts above are complete; list what you ' +
        'need with `ls` or `find` inside a directory.',
    )
  }
  if (neighbours.length > 0) {
    lines.push(
      '',
      '## Neighbouring territories',
      '',
      'Other passes of this expedition own these. Read into them when you need to know whether ' +
        'something is already handled, and leave their defects to them:',
      ...neighbours.map((label) => `- ${label}`),
    )
  }
  return lines.join('\n')
}

/** Files per directory, deepest-path-first ordering removed: plain alphabetical by directory. */
function directoryCounts(files: readonly string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const slash = file.lastIndexOf('/')
    const directory = slash === -1 ? '.' : file.slice(0, slash)
    counts.set(directory, (counts.get(directory) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export const BUG_FISHER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: BUG_FISHER_KIND,
    systemPrompt: BUG_FISHER_SYSTEM_PROMPT,
    // Code-aware, so the engine RESOLVES the task's selected best-practice fragments for this
    // step: what "correct" means for this service is exactly what an expedition measures the code
    // against, and without the trait the task's chosen standards are silently dropped by
    // `AgentContextBuilder.resolveFragments`. Where they are then delivered is
    // `standardsDelivery`, below. Spec-aware for the requirements angle: the committed specs are
    // the other half of "what was this supposed to do".
    traits: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
    // The task's best-practice standards arrive as `.cat-context/` FILES rather than folded into
    // the system prompt (the PR reviewer's precedent). A `code-aware` kind folds them by default,
    // and an agentic loop re-sends its whole system prompt on every turn of every pass: across
    // an expedition's passes that is the same standards text paid for dozens of times, to be read
    // once. As files, a standard is read when the angle needs it.
    standardsDelivery: 'context-files',
    // The other half of that decision, and it is not optional: `standardsDelivery` only stops the
    // engine folding the standards in. Without the op that WRITES them, a `code-aware` kind
    // declaring `context-files` does not deliver its standards more cheaply, it stops delivering
    // them, and the loss is invisible: the pass simply reviews against nothing. The THIRD half is
    // the prompt: `STANDARDS_AS_CONTEXT_FILES_GUIDANCE` above is what tells the pass the files are
    // there at all, and without it the op writes into a directory the agent never opens.
    preOps: [standardsAsContextFilesPreOp],
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

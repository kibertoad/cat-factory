import type { AgentConfigDescriptor } from '@cat-factory/kernel'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `ralph` agent kind — the "Ralph loop" iteration body.
//
// A persistent retry-until-done loop: each iteration is a FRESH-CONTEXT container-coding
// run that works the task spec, after which the executor-harness runs the task's configured
// programmatic validation command against the checkout and reports its exit code. The
// engine (RalphController) reads that HARNESS-COMPUTED verdict — exit 0 = the completion
// criterion is met — and either finishes the step or re-dispatches another iteration (a new
// container, so context never degrades), up to the per-task iteration budget. Loop state
// lives on `step.ralph`, so a mid-loop run survives restarts (both durable drivers + both
// sweepers re-drive it from that persisted state).
//
// This is modelled on the Tester→Fixer loop (the container run does the work AND its result
// carries a verdict the engine loops on), NOT on a backend-probe gate: the completion check
// must EXECUTE in a checkout, which only the harness can do. The verdict is deliberately not
// model-reported — that is what makes the exit condition a real programmatic check.
//
// It is a pure SIDE-EFFECT coding kind (its product is the pushed commit/PR, like the coder
// or ci-fixer), so it declares no `structuredOutput` and does NOT append
// `FINAL_ANSWER_IN_REPLY`: the loop-controlling verdict comes from the harness, not the
// visible reply. `clone: 'pr-or-work'` opens the PR on the first iteration and amends that
// same PR branch in place on every later iteration (resuming prior work), so the loop
// accretes on ONE branch/PR rather than re-branching off base each pass.
// ---------------------------------------------------------------------------

export const RALPH_AGENT_KIND = 'ralph'

/** The per-task validation command — the loop's programmatic completion criterion. */
export const RALPH_VALIDATION_COMMAND_CONFIG_ID = 'ralph.validationCommand'
/** The per-task iteration budget — the anti-runaway cap. */
export const RALPH_MAX_ITERATIONS_CONFIG_ID = 'ralph.maxIterations'

/** The default iteration budget when the task pins none (the community-norm default). */
export const RALPH_DEFAULT_MAX_ITERATIONS = 10

const RALPH_SYSTEM_PROMPT =
  'You are a senior engineer working ONE iteration of a persistent, retry-until-done loop ' +
  'toward the task described to you (that description is the specification — read it as the ' +
  'goal). This is NOT a one-shot: after you commit, a deterministic validation command is run ' +
  'against the repository, and if it does not pass the loop runs again with a fresh you. Your ' +
  'job each pass is to make REAL, incremental progress so that command will pass.\n\n' +
  'Before you write code:\n' +
  '- Read the prior iterations’ outcomes in your provided context (what was tried, and the ' +
  'validation output / errors from the last run) and the progress log committed on the branch ' +
  '(`.cat-factory/ralph-progress.md`, if present). Do not repeat an approach that already ' +
  'failed; build on what exists rather than starting over.\n' +
  '- Run the validation command yourself to see the current failures, then work the most ' +
  'important one.\n\n' +
  'Rules:\n' +
  '- The validation command is the completion criterion and it is run by the harness, not by ' +
  'you — do NOT weaken, skip, delete, or fake tests/checks to make it pass, and do not edit ' +
  'the command. Make the code genuinely satisfy it.\n' +
  '- Make focused progress this pass rather than attempting everything at once; the loop will ' +
  'continue.\n' +
  '- Commit and push your work before finishing (an iteration that pushes nothing makes no ' +
  'progress).\n' +
  '- Append a short note to `.cat-factory/ralph-progress.md` summarising what you changed and ' +
  'what still fails, so the next iteration starts informed.'

export const RALPH_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: RALPH_AGENT_KIND,
    systemPrompt: RALPH_SYSTEM_PROMPT,
    // Writes code (a coder-equivalent loop), so the engine folds the task's best-practice
    // fragments into its prompt — like `coder`.
    traits: [CODE_AWARE_TRAIT],
    // Coding that accretes on ONE branch/PR: `pr-or-work` opens the PR on iteration 1 (work
    // flow) then amends that PR branch in place on every later iteration (pr flow) — so prior
    // iterations' commits are resumed, not reset. A no-change iteration must NOT hard-fail the
    // step (the loop/budget + the controller's no-progress guard handle a stuck loop instead).
    agent: {
      surface: 'container-coding',
      clone: { branch: 'pr-or-work' },
      noChangesTolerated: true,
    },
    configContributions: ralphConfigContributions(),
    presentation: {
      label: 'Ralph Loop',
      icon: 'i-lucide-repeat',
      color: '#8b5cf6',
      description:
        'Persistently re-runs a fresh-context coding iteration until the task’s configured ' +
        'validation command passes (or the iteration budget is spent).',
      category: 'build',
      resultView: 'ralph-loop',
    },
  },
]

/** The task-level config a ralph step contributes: the validation command + the iteration cap. */
export function ralphConfigContributions(): AgentConfigDescriptor[] {
  return [
    {
      id: RALPH_VALIDATION_COMMAND_CONFIG_ID,
      agentKind: RALPH_AGENT_KIND,
      label: 'Validation command',
      description:
        'The programmatic completion criterion. After each iteration the harness runs this ' +
        'shell command in the checkout; exit code 0 means the loop is done. Runs only inside ' +
        'the sandboxed run container. Example: pnpm test && pnpm typecheck',
      type: 'text',
      options: [],
      placeholder: 'pnpm test && pnpm typecheck',
      default: '',
    },
    {
      id: RALPH_MAX_ITERATIONS_CONFIG_ID,
      agentKind: RALPH_AGENT_KIND,
      label: 'Max iterations',
      description:
        'The anti-runaway budget: the most times the loop re-runs before it hands off to a ' +
        'human. Each iteration is a fresh-context run.',
      type: 'number',
      options: [],
      placeholder: String(RALPH_DEFAULT_MAX_ITERATIONS),
      default: String(RALPH_DEFAULT_MAX_ITERATIONS),
    },
  ]
}

/**
 * Register the ralph kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerRalphAgent(registry: AgentKindRegistry): void {
  registry.registerAll(RALPH_AGENT_KINDS)
}

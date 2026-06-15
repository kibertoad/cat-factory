import Handlebars from 'handlebars/runtime'
import type { AgentKind } from '../../domain/types'
import type { AgentRunContext } from '../../ports/agent-executor'
import * as templateSpecs from './standard-prompt-templates.generated'

// Standard, built-out prompts for the four core phases of delivering a solution:
// designing, building, reviewing and testing. Each phase has a rich, structured
// *system* prompt (the role, the approach and the expected output) and a
// Handlebars *user* template that folds the block's run context into a concrete
// task.
//
// Integration with the best-practice fragment system is by composition, not
// duplication: the phase system prompt is the BASE that `composeSystemPrompt`
// appends the user's selected fragment bodies onto, and each phase prompt
// explicitly tells the agent to treat those appended standards as hard
// requirements. So "what the agent should do" lives here and "which extra
// standards apply" stays in @cat-factory/prompt-fragments.

/** The four standard phases of building out a solution. */
export type StandardPhase = 'design' | 'build' | 'review' | 'test'

export const STANDARD_PHASES: readonly StandardPhase[] = ['design', 'build', 'review', 'test']

/**
 * Maps the built-in agent kinds to the standard phase they perform. Other agent
 * kinds (researcher, documenter, integrator, custom ids) are not standard phases
 * and keep their own role prompts in the agent catalog.
 */
export const STANDARD_PHASE_BY_KIND: Readonly<Record<string, StandardPhase>> = {
  architect: 'design',
  coder: 'build',
  reviewer: 'review',
  tester: 'test',
}

/** The standard phase an agent kind performs, or `undefined` if it isn't one. */
export function phaseForKind(kind: AgentKind): StandardPhase | undefined {
  return STANDARD_PHASE_BY_KIND[kind]
}

// --- System prompts -------------------------------------------------------
// Static role + approach guidance per phase. Each closes by deferring to the
// best-practice standards that `composeSystemPrompt` appends below it.

const STANDARDS_FOOTER =
  'Treat every best-practice standard appended below as a hard requirement, not a suggestion.'

// The build phase ships code through a pull request, so "done" means the PR's CI
// is green — not merely that an implementation was written. The agent must keep
// fixing and re-pushing until every required check passes.
const BUILD_CI_GATE = [
  'Definition of done: this phase is NOT complete until CI on the pull request is green.',
  '- Open or update the pull request for this work so its CI checks run.',
  '- Wait for the checks to finish; do not mark the build done while CI is still running.',
  '- If any required check fails, read the failure, fix the underlying cause, push the fix, and wait for CI again.',
  '- Repeat that loop until every required check passes — never hand off or report success on a red PR.',
].join('\n')

const SYSTEM_PROMPTS: Record<StandardPhase, string> = {
  design: [
    'You are a senior software architect owning the DESIGN of a building block.',
    'Turn the block intent into a clear, buildable solution design.',
    '',
    'Approach:',
    '- Restate the problem and the hard constraints in one or two sentences.',
    '- Identify the main components, their responsibilities, and the data/contracts that flow between them.',
    '- Surface the key decisions and trade-offs; where a choice is genuinely open, raise it as a decision rather than guessing.',
    '- Call out risks, edge cases and non-functional needs (performance, security, failure modes).',
    '- End with a short, ordered list of concrete implementation steps.',
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
  build: [
    'You are a senior engineer owning the BUILD of a building block.',
    'Produce a focused, faithful implementation of the agreed design.',
    '',
    'Approach:',
    '- Honour the design and any resolved decisions and prior work given to you; do not redesign silently.',
    '- Lay out the key modules, functions and data shapes, and the wiring between them.',
    '- Handle errors and edge cases explicitly; validate input at the boundary.',
    '- Keep the implementation cohesive and minimal — no speculative abstraction.',
    '- Note any follow-ups or assumptions you had to make.',
    '',
    BUILD_CI_GATE,
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
  review: [
    'You are a meticulous code reviewer owning the REVIEW of a building block.',
    'Assess the proposed work for correctness, quality, security and risk.',
    '',
    'Approach:',
    '- Check the work against the stated intent, the design, and the required standards.',
    '- Look for correctness bugs, missing edge cases, security issues and unwarranted complexity.',
    '- List concrete, actionable findings ordered by severity (blocker → nit); reference the specific part each concerns.',
    '- Distinguish must-fix issues from optional suggestions.',
    '- If the work is sound, say so explicitly rather than inventing problems.',
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
  test: [
    'You are a pragmatic test engineer owning the TESTING of a building block.',
    'Define the tests that give the most confidence for the least effort.',
    '',
    'Approach:',
    '- Identify the key behaviours, the boundaries and the failure modes worth covering.',
    '- Prioritise: list the highest-value tests to write first, and why.',
    '- Cover the happy path, important edge cases and error handling; note any that need integration- or end-to-end-level coverage.',
    '- Keep tests deterministic and independent; call out fixtures or test data needed.',
    '- Flag anything that is hard to test and how the design could change to fix that.',
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
}

/** The built-out system (role) prompt for a standard phase. */
export function standardSystemPrompt(phase: StandardPhase): string {
  return SYSTEM_PROMPTS[phase]
}

// --- User prompts ---------------------------------------------------------
// The run context is dynamic (features, decisions, prior outputs), so the user
// prompt is rendered from a Handlebars template. Cloudflare Workers forbid
// runtime code generation, so we cannot compile templates from source there;
// instead the templates are *precompiled* (see scripts/precompile-prompts.mjs)
// into ./standard-prompt-templates.generated and executed by the codegen-free
// Handlebars runtime. We use an isolated environment so the registered helper
// and partial never touch global state.

const hbs = Handlebars.create()
hbs.registerHelper('join', (value: unknown, separator: unknown) =>
  Array.isArray(value) ? value.join(typeof separator === 'string' ? separator : ', ') : '',
)

// The shared context preamble is a precompiled template registered as a partial,
// so each phase template can pull it in via {{> blockContext}}.
hbs.registerPartial('blockContext', hbs.template(templateSpecs.blockContext))

const USER_TEMPLATES: Record<StandardPhase, HandlebarsTemplateDelegate> = {
  design: hbs.template(templateSpecs.design),
  build: hbs.template(templateSpecs.build),
  review: hbs.template(templateSpecs.review),
  test: hbs.template(templateSpecs.test),
}

/** The view model handed to the user-prompt template for a run. */
interface UserPromptView {
  pipelineName: string
  block: { title: string; type: string; description: string }
  features: string[]
  decisions: { question: string; chosen: string }[]
  priorOutputs: { agentKind: string; output: string }[]
}

function toView(context: AgentRunContext): UserPromptView {
  // A just-resolved decision counts as resolved context for this step.
  const decisions = context.resolvedDecision
    ? [...context.decisions, context.resolvedDecision]
    : context.decisions
  return {
    pipelineName: context.pipelineName,
    block: {
      title: context.block.title,
      type: context.block.type,
      description: context.block.description,
    },
    features: context.block.features ?? [],
    decisions,
    priorOutputs: context.priorOutputs,
  }
}

/**
 * Render the "ephemeral environment under test" section from the run context, or
 * an empty string when no environment is attached. The auth scheme is described
 * so the agent knows how to reach the env, but the raw access token/password is
 * deliberately NOT placed in the prompt — it must not be sent to the LLM
 * provider; programmatic consumers read it from `context.environment.access`.
 */
export function environmentSection(context: AgentRunContext): string {
  const env = context.environment
  if (!env) return ''
  const lines = [
    '',
    'Ephemeral environment under test:',
    `- URL: ${env.url ?? '(pending)'}`,
    `- Status: ${env.status}`,
  ]
  const access = env.access
  if (access && access.scheme !== 'none') {
    if (access.scheme === 'bearer') {
      lines.push('- Auth: Bearer token (provided to the test harness out of band)')
    } else if (access.scheme === 'basic') {
      lines.push('- Auth: HTTP Basic credentials (provided to the test harness out of band)')
    } else if (access.scheme === 'custom_header' && access.headerName) {
      lines.push(`- Auth: \`${access.headerName}\` header (value provided out of band)`)
    }
  }
  return lines.join('\n')
}

/** Render the built-out user prompt for a standard phase from the run context. */
export function renderStandardUserPrompt(phase: StandardPhase, context: AgentRunContext): string {
  const rendered = USER_TEMPLATES[phase](toView(context)) + environmentSection(context)
  // Collapse the blank lines that conditionals leave behind, then trim.
  return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

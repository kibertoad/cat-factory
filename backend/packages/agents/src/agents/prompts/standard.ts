// Runtime VALUE from the codegen-free runtime build (Workers forbid runtime code
// generation); its Node-ESM specifier needs the explicit `.js`. The TYPE is sourced
// from the full package (the runtime subpath's types omit `create`), type-only so the
// compiler is not pulled into the bundle.
import HandlebarsRuntime from 'handlebars/runtime.js'
import type { AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import { CONTEXT_BUDGET, estimateTokens, renderTaskContext } from '@cat-factory/kernel'
import { PLATFORM_DELIVERY_CONTRACT } from './delivery-contract.js'
import { FINAL_ANSWER_IN_REPLY, STANDARDS_FOOTER } from './shared.js'
import * as templateSpecs from './standard-templates.generated.js'

const Handlebars = HandlebarsRuntime as unknown as typeof import('handlebars')

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
  // `tester` is no longer a one-shot strategy phase: it is a container agent that
  // actually runs the tests and returns a structured report (see ./test-prompts),
  // looped with the `fixer` by the engine. It therefore routes through its own
  // prompt, not the generic `test` phase.
}

/** The standard phase an agent kind performs, or `undefined` if it isn't one. */
export function phaseForKind(kind: AgentKind): StandardPhase | undefined {
  return STANDARD_PHASE_BY_KIND[kind]
}

// --- System prompts -------------------------------------------------------
// Static role + approach guidance per phase. Each closes by deferring to the
// best-practice standards that `composeSystemPrompt` appends below it.

// The build phase runs in a container on a real checkout and ships its code through
// a pull request — but the PUSH and the PR are the platform's job, not the agent's
// (it has no push credentials). "Done" here means a complete implementation that
// builds and passes its relevant tests locally; the platform then pushes, opens the
// PR and drives CI (dispatching a CI-fixer if a check fails). The shared
// PLATFORM_DELIVERY_CONTRACT spells out that boundary so the agent commits its own
// work, never chases credentials, and bounds its effort.
const BUILD_DELIVERY_GATE = [
  'Definition of done: a focused, complete implementation that builds and passes its relevant tests locally.',
  PLATFORM_DELIVERY_CONTRACT,
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
    FINAL_ANSWER_IN_REPLY,
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
    '- If the task context flags it as TECHNICAL (a refactor / non-functional / internal change), the task definition and any incorporated requirements are the PRIMARY source of truth: implement to them, and treat the committed `spec/` only as a regression-spotting reference (do not invent behaviour to match a spec the task did not ask to change). Otherwise the specification leads as usual.',
    '',
    BUILD_DELIVERY_GATE,
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
    FINAL_ANSWER_IN_REPLY,
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
    FINAL_ANSWER_IN_REPLY,
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
// into ./standard-templates.generated and executed by the codegen-free
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
    decisions,
    priorOutputs: context.priorOutputs,
  }
}

/** The reachable coordinates of a provisioned environment, parsed from its URL. */
interface EnvironmentCoordinates {
  host: string
  /** Port — explicit from the URL, else the scheme default (443/80), else null. */
  port: number | null
  /** URL scheme without the trailing colon (e.g. `https`). */
  scheme: string
}

/**
 * Derive standardized coordinates from an environment URL, or null when there is no URL or
 * it does not parse. Having one deriver means the Tester prompt gets a consistent
 * host/port/scheme breakdown regardless of which provider stood the environment up — no
 * per-provider change required. When the URL omits an explicit port, fall back to the
 * scheme default (`https`→443, `http`→80) so the Tester always has a concrete port.
 */
function deriveEnvironmentCoordinates(
  url: string | null | undefined,
): EnvironmentCoordinates | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  const port = parsed.port
    ? Number(parsed.port)
    : scheme === 'https'
      ? 443
      : scheme === 'http'
        ? 80
        : null
  return { host: parsed.hostname, port, scheme }
}

/**
 * Render the "ephemeral environment under test" section from the run context, or
 * an empty string when no environment is attached. Surfaces the standardized
 * coordinates (URL + host/port/scheme, derived once via {@link deriveEnvironmentCoordinates})
 * so the agent has an unambiguous target, plus the FULL endpoint access credentials.
 *
 * These are TEST-environment access credentials (a throwaway ingress token / basic
 * login for an ephemeral env), treated by the system as non-sensitive: the Tester
 * cannot authenticate without them and they reach the model regardless of channel, so
 * they go straight into the prompt rather than a fictional "out of band" path (the empty
 * version of which is exactly what left earlier Testers unable to reach the environment).
 */
export function environmentSection(context: AgentRunContext): string {
  const env = context.environment
  if (!env) return ''
  const coords = deriveEnvironmentCoordinates(env.url)
  const lines = ['', 'Ephemeral environment under test:', `- URL: ${env.url ?? '(pending)'}`]
  if (coords) {
    lines.push(
      `- Host: ${coords.host}   Port: ${coords.port ?? '(default)'}   Scheme: ${coords.scheme}`,
    )
  }
  lines.push(`- Status: ${env.status}`)
  const access = env.access
  if (access && access.scheme !== 'none') {
    if (access.scheme === 'bearer' && access.token) {
      lines.push(`- Auth: Bearer token \`${access.token}\` (send as \`Authorization: Bearer …\`)`)
    } else if (access.scheme === 'basic' && access.username !== undefined) {
      lines.push(
        `- Auth: HTTP Basic — username \`${access.username}\`, password \`${access.password ?? ''}\``,
      )
    } else if (access.scheme === 'custom_header' && access.headerName) {
      lines.push(`- Auth: header \`${access.headerName}: ${access.headerValue ?? ''}\``)
    }
  }
  return lines.join('\n')
}

/**
 * Render the "involved services" section from the run context — the connected services directly
 * involved in this task beyond its own (the connections initiative), each with the connection
 * `description` prose explaining the relationship and (when live this run) the URL of its ephemeral
 * environment. Empty string when the task names no (still-valid) involved services. Lets a
 * cross-service test / change reason about the peer and reach its real environment.
 */
export function involvedServicesSection(context: AgentRunContext): string {
  const involved = context.involvedServices
  if (!involved?.length) return ''
  const lines = ['', 'Involved connected services:']
  for (const service of involved) {
    const parts = [`- ${service.title}`]
    if (service.description) parts.push(`— ${service.description}`)
    if (service.envUrl) parts.push(`(live environment: ${service.envUrl})`)
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
}

/**
 * Directory in the agent's checkout where the harness materialises the full text of
 * each linked-context item (requirements / RFCs / PRDs / tracker issues), so a
 * container agent can read what it needs on demand rather than carrying every body in
 * its prompt. Kept in sync with the harness's own constant (executor-harness has no
 * dependency on this package).
 */
export const CONTEXT_DIR = '.cat-context'

/**
 * Render the linked extra-context section — documents (requirements / RFCs /
 * PRDs) and tracker issues attached to the block — or an empty string when none
 * are linked. Shared by every agent kind (standard phases and the generic roles
 * alike) so the same context the engine resolves for a step (see
 * `ExecutionService.buildAgentContext`) reaches whichever agent runs it.
 *
 * `opts.materialized` (container kinds) renders a cheap summary index pointing at
 * {@link CONTEXT_DIR}; otherwise (inline kinds, which have no checkout) it injects the
 * bodies directly, trimmed to {@link CONTEXT_BUDGET}. The leading blank lines separate
 * it from the preceding prompt content; `renderStandardUserPrompt` collapses runs.
 */
export function linkedContextSection(
  context: AgentRunContext,
  opts: { materialized?: boolean } = {},
): string {
  const { contextDocs, contextTasks } = context.block
  if (!contextDocs?.length && !contextTasks?.length) return ''

  // Container kinds run with a checkout: list the linked items cheaply and point the
  // agent at the full text materialised under CONTEXT_DIR, so it reads only what it
  // needs instead of paying for every body in the prompt.
  if (opts.materialized) {
    const items: string[] = []
    for (const doc of contextDocs ?? []) items.push(`- ${doc.title} — ${doc.summary} (${doc.url})`)
    for (const task of contextTasks ?? [])
      items.push(`- [${task.key}] ${task.title} (${task.status}) — ${task.summary} (${task.url})`)
    const capped = items.slice(0, CONTEXT_BUDGET.maxItems)
    return `\n${[
      '',
      'Linked context (requirements / RFCs / PRDs / tracker issues). The full text of each',
      `is in the \`${CONTEXT_DIR}/\` directory of your checkout — open a file when it is`,
      'relevant. Do not try to reach external systems; everything available is already on disk.',
      ...capped,
    ].join('\n')}`
  }

  // Inline kinds have no checkout to explore, so inject the bodies directly, trimmed to
  // the shared budget (largest-first is not worth it for the handful of linked items).
  const lines: string[] = []
  let spent = 0
  if (contextDocs?.length) {
    lines.push('', 'Linked context documents (requirements / RFCs / PRDs):')
    for (const doc of contextDocs) {
      const remaining = CONTEXT_BUDGET.inlineBodyTokens - spent
      if (remaining <= 0) break
      const slice = clampToTokens(doc.body || doc.excerpt, remaining)
      spent += estimateTokens(slice)
      lines.push(`### ${doc.title} (${doc.url})`, slice)
    }
  }
  if (contextTasks?.length) {
    lines.push('', 'Linked tracker issues (extra context):')
    for (const task of contextTasks) lines.push(renderTaskContext(task))
  }
  return lines.length ? `\n${lines.join('\n')}` : ''
}

/** Truncate text to roughly `maxTokens`, marking the cut so the reader knows it's partial. */
function clampToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}\n…(truncated)` : text
}

/**
 * Render the "this task is TECHNICAL" marker when the block carries the resolved
 * technical label, or an empty string otherwise. The static rule for how to act on it
 * lives in the BUILD system prompt; this is the per-task signal that activates it (so the
 * implementer knows to treat the task definition as primary and the spec as a reference).
 * Only the build user prompt appends it (see {@link renderStandardUserPrompt}) — the
 * architect/reviewer phases have no matching system rule, so they keep their normal,
 * spec-led behaviour.
 */
export function technicalContextSection(context: AgentRunContext): string {
  if (!context.block.technical) return ''
  return [
    '',
    'This task is flagged TECHNICAL (a refactor / non-functional / internal change). Treat',
    'the task definition and any incorporated requirements above as the PRIMARY source of',
    'truth, and the committed `spec/` only as a regression-spotting reference — do not',
    'invent behaviour to satisfy a spec this task did not set out to change.',
  ].join('\n')
}

/** Render the built-out user prompt for a standard phase from the run context. */
export function renderStandardUserPrompt(
  phase: StandardPhase,
  context: AgentRunContext,
  opts: { materialized?: boolean } = {},
): string {
  const rendered =
    USER_TEMPLATES[phase](toView(context)) +
    linkedContextSection(context, opts) +
    environmentSection(context) +
    involvedServicesSection(context) +
    // Only the implementer (build) acts on the TECHNICAL marker — its system prompt carries
    // the matching rule. The architect/reviewer have no such rule, so don't change their prompt.
    (phase === 'build' ? technicalContextSection(context) : '')
  // Collapse the blank lines that conditionals leave behind, then trim.
  return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

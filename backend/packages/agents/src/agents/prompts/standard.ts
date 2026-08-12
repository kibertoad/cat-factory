// Runtime VALUE from the codegen-free runtime build (Workers forbid runtime code
// generation); its Node-ESM specifier needs the explicit `.js`. The TYPE is sourced
// from the full package (the runtime subpath's types omit `create`), type-only so the
// compiler is not pulled into the bundle.
import HandlebarsRuntime from 'handlebars/runtime.js'
import type { AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext, DesignImageUnavailableReason } from '@cat-factory/kernel'
import {
  BINARY_GENERATED_DIR,
  CONTEXT_BUDGET,
  estimateTokens,
  freshnessHeaderLines,
  originSuffix,
  renderTaskContext,
} from '@cat-factory/kernel'
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
    '- If the task context pins a CHOSEN IMPLEMENTATION APPROACH, implement that approach faithfully — do not silently switch to an alternative; if it proves unworkable, surface a follow-up rather than drifting into a rejected alternative.',
    '- If the task context flags it as TECHNICAL (a refactor / non-functional / internal change), the task definition and any incorporated requirements are the PRIMARY source of truth: implement to them, and treat the committed `spec/` only as a regression-spotting reference (do not invent behaviour to match a spec the task did not ask to change). Otherwise the specification leads as usual.',
    '- The committed `spec/` splits its requirements by IMPLEMENTATION STATE, and the two halves mean opposite things. Requirements under an "established" heading are STANDING behaviour the service already honours: keep them working, and treat breaking one as a regression. Requirements under an "aspirational (not yet built)" heading are agreed but NOT yet true: do NOT assume the code already does them, do NOT read their absence as a bug to fix, and do NOT implement one unless THIS task asks for it. Building an aspirational requirement nobody asked you for is scope you were not given.',
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
/**
 * Render the service the work BELONGS to — the enclosing service frame's title and description.
 *
 * Unlike every other section here this one renders when the value is ABSENT too, and that is the
 * point. A block's own title and description are the only subject an agent gets, and a short one
 * ("implement webhooks") names no system; with the owning service silently omitted, that reads
 * exactly like a task whose product is obvious from context, so a model fills the gap itself and
 * states the invention as confidently as a fact. Naming the absence turns "I must work out what
 * this is about" into "the platform did not tell me", which is a thing an agent can report instead
 * of paper over (see the `NO_ASSUMED_PRODUCT` directive, which this section is the input to).
 *
 * Empty for a FRAME-level run, where the block under work IS the service and its own title already
 * answers the question, and for a context that never populated the field.
 */
export function ownServiceSection(context: AgentRunContext): string {
  const own = context.ownService
  if (!own) return ''
  if (!own.stated) {
    if (own.reason === 'block-is-the-service') return ''
    return (
      '\n\nThe system this work belongs to: NOT STATED — this work is not under a service on the ' +
      'board, so no owning system, product or domain was resolved for it. Work only from the ' +
      'title and description above; do not infer a product, vendor or domain they do not name.'
    )
  }
  const lines = ['', `The system this work belongs to: ${own.title}`]
  if (own.description?.trim()) lines.push(own.description.trim())
  return `\n${lines.join('\n')}`
}

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
 * Render the SENSITIVE test-credentials section — the keys + descriptions of the secrets the
 * platform injected into the tester's container ENVIRONMENT out of band. Only the non-secret
 * KEY + DESCRIPTION appear here; the VALUE reaches the container as an environment variable
 * (`$KEY`), never the prompt, so the agent is told what is available and how to use it without
 * the secret ever being written into the prompt or telemetry. Empty string when the run carries
 * no test secrets (every non-tester run, and tester runs whose service configured none).
 */
export function testSecretsSection(context: AgentRunContext): string {
  const secrets = context.testSecrets
  if (!secrets?.length) return ''
  const lines = [
    '',
    'Sensitive test credentials (injected as environment variables — read them from the',
    'environment, e.g. `$STRIPE_API_KEY`; they are NOT printed here and must not be logged):',
  ]
  for (const secret of secrets) {
    lines.push(`- \`${secret.key}\`${secret.description ? ` — ${secret.description}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Render the initiative-PRESET steering section — the `## Initiative preset: <label>` header plus
 * the preset's per-agent-kind `promptAddition` (already resolved for the running kind by the
 * engine's context builder). This is the standing, preset-level methodology an org attaches to a
 * kind; on an initiative-SPAWNED run (coder / tester / a custom kind) it is the vehicle that
 * carries that methodology into the child's prompt (D1) — item-level specifics ride the block
 * `description` instead. Empty string when the run carries no preset addition (every
 * non-initiative run, and initiative runs whose preset contributes no addition for this kind), so
 * the prompt stays byte-for-byte unchanged. The preset's `phaseTemplate` is deliberately NOT
 * rendered here — it is the planner's "required plan shape", folded only into the planner prompt.
 * Shared by the standard-phase prompt, the generic custom-kind prompt, and the planning prompts so
 * the section text has a single source of truth.
 */
export function initiativePresetSection(context: AgentRunContext): string {
  const preset = context.initiative?.preset
  const addition = preset?.promptAddition?.trim()
  if (!preset || !addition) return ''
  return ['', `## Initiative preset: ${preset.label}`, '', addition].join('\n')
}

/**
 * Render the custom task type's collected PARAMETERS: the per-case brief a reusable operation was
 * invoked with ("expose CRUD for entity Order", "auth: service-to-service"). The engine resolves
 * the projection once per dispatch ({@link AgentRunContext.customTaskType}); this only formats it,
 * so the container, inline and consensus paths render one thing.
 *
 * APPENDED after the block-context template rather than prepended: the requester's own title and
 * description stay the primary statement of what is wanted, and the parameters qualify it. Empty
 * string on every run that collected none (each built-in type, and a custom type with no fields),
 * so every existing prompt is byte-for-byte unchanged.
 *
 * A field whose descriptor is gone renders under its raw key. The projection is
 * value-authoritative, and this must not second-guess it by hiding what it could not label.
 *
 * A MULTI-LINE value (a `textarea` field: the example operation's "anything else the design must
 * honour") continues as an indented block under its label rather than inline, or its second line
 * leaves the bullet list and its last one runs into the closing guidance below, reading as part of
 * the platform's own instruction rather than as something the requester typed.
 */
export function customTaskTypeSection(context: AgentRunContext): string {
  const custom = context.customTaskType
  if (!custom?.fields.length) return ''
  const lines = ['', `## Task parameters (${custom.label})`, '']
  for (const field of custom.fields) {
    const label = field.label ?? field.key
    // Split on either ending: a browser posts a textarea's newlines as CRLF, and a stray `\r` left
    // mid-prompt is a character the model has to read past on every turn.
    const valueLines = field.value.split(/\r?\n/)
    if (valueLines.length === 1) {
      lines.push(`- ${label}: ${valueLines[0]}`)
      continue
    }
    lines.push(`- ${label}:`)
    for (const line of valueLines) lines.push(`  ${line}`)
  }
  lines.push(
    '',
    'These are the values this task was created with. Treat them as the specifics of what to ' +
      'deliver; they qualify the title and description above rather than replacing them.',
  )
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
 * Subdirectory of {@link CONTEXT_DIR} holding the REFERENCE DESIGN images a run was handed: the
 * frames the task's linked designs retained plus the images a person uploaded against it.
 *
 * Named here because the tester prompt points the agent at it, and written by the harness, which
 * depends on no workspace package. So, like {@link CONTEXT_DIR}, the constant exists twice and
 * the two copies are pinned byte-for-byte by the harness's contract conformity suite. A drift
 * would leave the agent looking in an empty directory beside a full one, which reads to it
 * exactly like a task with no designs linked.
 */
export const REFERENCE_SCREENSHOT_DIR = `${CONTEXT_DIR}/reference-screenshots`

/**
 * Subdirectory of {@link CONTEXT_DIR} holding the design pictures a BUILDING kind was handed: the
 * same artifacts {@link REFERENCE_SCREENSHOT_DIR} carries for a capture, delivered for the agent to
 * LOOK at rather than to compare captures against.
 *
 * A separate directory rather than a shared one, because the two deliveries are capped differently
 * and answer different questions: a tester reading the builder's six pictures would take them for
 * the complete list of views to capture, and a builder reading the tester's twenty-four would spend
 * its context on screens it was never asked to touch.
 *
 * Written by the harness, which depends on no workspace package, so (like {@link CONTEXT_DIR}) the
 * constant exists twice and the copies are pinned byte-for-byte by the harness contract suite.
 */
export const DESIGN_RENDER_DIR = `${CONTEXT_DIR}/design-renders`

/**
 * Subdirectory of {@link CONTEXT_DIR} where a HARNESS-SERVED binary generator's output is staged
 * for the agent to pick up and store.
 *
 * It exists because the alternative is worse in two distinct ways. Codex writes its `image_gen`
 * output under `$CODEX_HOME` and exposes no path for it to the model, so an agent told to "upload
 * what you generated" has nothing to act on; and `$CODEX_HOME` is where the run's decrypted
 * subscription credential lives, so sending the agent to look there would point a
 * prompt-injectable process at it. The harness redirects the tool's output here instead, and this
 * is the ONE path the brief names.
 *
 * Under {@link CONTEXT_DIR}, so it inherits the git exclude that keeps a not-yet-uploaded artifact
 * out of the `git add -A` a coding run ends with. Written by the harness, which depends on no
 * workspace package, so (like {@link CONTEXT_DIR}) the constant exists twice and the copies are
 * pinned byte-for-byte by the harness contract suite.
 *
 * The subdirectory comes from kernel's own path vocabulary rather than a literal, so the brief
 * (rendered in kernel) and the prompt (rendered here) cannot name different directories: that
 * would leave exactly THREE copies of one path with only two of them pinned.
 */
export const GENERATED_BINARY_DIR = `${CONTEXT_DIR}/${BINARY_GENERATED_DIR}`

/**
 * The design pictures this dispatch holds, and what became of them.
 *
 * Rendered from BOTH halves of the answer, which is why it is one section rather than a list the
 * delivery path appends to: the engine resolved a set, and the dispatch either put it in front of
 * the model or could not. Every outcome is stated, because on the agent's side an absent picture
 * and a screen the design does not have are the same thing, and the difference decides whether it
 * should ask for the design or get on with the description it has.
 *
 * Empty (so byte-identical to the prior prompt) for every run whose task links no design.
 */
export function designImagesSection(context: AgentRunContext): string {
  const set = context.designImages
  const delivery = context.designImageDelivery
  if (!set?.files.length || !delivery) return ''
  const views = set.files.map((file) =>
    delivery.attached && delivery.channel === 'files'
      ? `- \`${DESIGN_RENDER_DIR}/${file.fileName}\`: ${file.view}`
      : `- ${file.view}`,
  )
  const lead = delivery.attached
    ? delivery.channel === 'files'
      ? [
          `The design for this task is also available AS PICTURES, one file per view under`,
          `\`${DESIGN_RENDER_DIR}/\`. Open them and build what they show: they are the design`,
          'itself, where the text description is a rendering of it.',
        ]
      : [
          'The design for this task is also attached to this message AS PICTURES, one per view, in',
          'the order listed below. Look at them and work from what they show: they are the design',
          'itself, where the text description is a rendering of it.',
        ]
    : [
        'This task has design pictures the platform could NOT put in front of you:',
        `${DESIGN_IMAGE_REFUSALS[delivery.reason]}.`,
        'Work from the textual design description above. Do not ask for the images and do not try',
        'to fetch them; nothing in this run can deliver them to you.',
      ]
  // Stated WITHOUT a cause, the same way the set itself records one: by the time this renders, a
  // view can be here because a ceiling dropped it or because its bytes never arrived, and those are
  // the same instruction to an agent (work from the text). Naming a cause meant naming the ceiling,
  // which read it off the DELIVERED count, so a run that lost two pictures in transfer reported
  // the survivors as its limit and blamed the loss on a cap that had not fired.
  const omitted = set.omitted.length
    ? [
        '',
        `Not included, and nothing in this run can add them: ${set.omitted.join(', ')}.`,
        'The textual design description above still covers those views.',
      ]
    : []
  return `\n\n## Design pictures\n${lead.join('\n')}\n\n${views.join('\n')}${omitted.join('\n')}`
}

/**
 * The agent-facing sentence for each way a delivery can fail. An exhaustive `Record`, so a new
 * member of the kernel vocabulary fails to compile until it has wording: the whole reason the
 * reasons are distinct is that they read differently to whoever hits them.
 *
 * Each states the CAUSE without naming a remedy, because the reader is the agent and none of the
 * fixes are its to make: a run told "ask an operator to configure this" spends turns on it.
 */
const DESIGN_IMAGE_REFUSALS: Record<DesignImageUnavailableReason, string> = {
  harness_no_image_input: 'the agent CLI running this step cannot read an image',
  model_no_image_input: 'the model running this step does not accept image input',
  unknown_model_image_input:
    'the platform does not know whether the model running this step accepts image input',
  inline_harness_text_only: 'this step reaches its model through a text-only channel',
  consensus_panel: 'this step is running as a multi-model panel, which carries text only',
  transfer_failed: 'they could not be retrieved from storage',
}

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
  return renderLinkedContext(contextDocs, contextTasks, opts)
}

/**
 * How many unseated documents the inline omission notice NAMES before falling back to a count.
 * The notice reports a budget overrun, so it must not be able to cause one.
 */
const UNSEATED_NAMED_LIMIT = 5

/**
 * The rendering half of {@link linkedContextSection}, taking the resolved docs/issues
 * directly instead of an {@link AgentRunContext}. Exists because the initiative-planning
 * INTERVIEWER is an inline service that never passes through the context builder (it
 * assembles its own prompt from the block + entity), yet must see the same attached
 * requirements the analyst and planner do — otherwise it interrogates the stakeholder
 * about facts the attached PRD already settles. Keeping one renderer means the two paths
 * cannot drift in wording or in the {@link CONTEXT_BUDGET} caps.
 */
export function renderLinkedContext(
  contextDocs: AgentRunContext['block']['contextDocs'],
  contextTasks: AgentRunContext['block']['contextTasks'],
  opts: { materialized?: boolean } = {},
): string {
  if (!contextDocs?.length && !contextTasks?.length) return ''

  // Container kinds run with a checkout: list the linked items cheaply and point the
  // agent at the full text materialised under CONTEXT_DIR, so it reads only what it
  // needs instead of paying for every body in the prompt.
  if (opts.materialized) {
    const items: string[] = []
    for (const doc of contextDocs ?? [])
      items.push(`- ${doc.title} — ${doc.summary}${originSuffix(doc.url)}`)
    for (const task of contextTasks ?? [])
      items.push(`- [${task.key}] ${task.title} (${task.status}) — ${task.summary} (${task.url})`)
    const capped = items.slice(0, CONTEXT_BUDGET.maxItems)
    // The index is capped, the DIRECTORY is not: every item was materialised (the materialiser
    // refuses an over-budget corpus rather than writing part of it). Say how many are unlisted, or
    // an agent reads the list as the complete set and never opens the files past it.
    const unlisted = items.length - capped.length
    return `\n${[
      '',
      'Linked context (requirements / RFCs / PRDs / tracker issues). The full text of each',
      `is in the \`${CONTEXT_DIR}/\` directory of your checkout — open a file when it is`,
      'relevant. Do not try to reach external systems; everything available is already on disk.',
      ...capped,
      ...(unlisted > 0
        ? [
            `…and ${unlisted} more not listed here: every linked item is on disk, so list`,
            `\`${CONTEXT_DIR}/\` to see the rest.`,
          ]
        : []),
    ].join('\n')}`
  }

  // Inline kinds have no checkout to explore, so inject the bodies directly, trimmed to
  // the shared budget (largest-first is not worth it for the handful of linked items).
  const lines: string[] = []
  let spent = 0
  if (contextDocs?.length) {
    lines.push('', 'Linked context documents (requirements / RFCs / PRDs):')
    // An inline caller has no `.cat-context/` to fall back on, so a document the budget can't seat
    // is genuinely absent from this prompt. A clamped body already marks its own cut; the ones that
    // got no room at all are named below (up to {@link UNSEATED_NAMED_LIMIT}), because an
    // unmentioned omission reads as "this task has no other requirements" — which is how an inline
    // reviewer confidently approves against a spec it never received.
    const unseated: typeof contextDocs = []
    for (const doc of contextDocs) {
      const remaining = CONTEXT_BUDGET.inlineBodyTokens - spent
      if (remaining <= 0) {
        unseated.push(doc)
        continue
      }
      // The SAME freshness note the materialised `.cat-context/` file carries, because an inline
      // kind has no such file and would otherwise receive an unconfirmed body indistinguishable
      // from a checked one, which is how a judge confidently scores against a design revision the
      // platform could not reach. Empty (so byte-identical) when there is nothing to state, and
      // charged to the budget like any other text, so the notice can never cause the overrun the
      // clamp exists to prevent.
      const freshness = freshnessHeaderLines(doc.freshness).trimEnd()
      const slice = clampToTokens(doc.body || doc.excerpt, remaining)
      spent += estimateTokens(slice) + estimateTokens(freshness)
      lines.push(
        `### ${doc.title}${originSuffix(doc.url)}`,
        ...(freshness ? [freshness] : []),
        slice,
      )
    }
    if (unseated.length) {
      // The notice is BOUNDED, or it becomes the overrun it exists to report: a task with thirty
      // attachments would append thirty titles and URLs to a prompt that just ran out of budget.
      // Naming a handful and counting the rest is what the materialized index above does too.
      const named = unseated.slice(0, UNSEATED_NAMED_LIMIT)
      const rest = unseated.length - named.length
      lines.push(
        '',
        `${unseated.length} further linked document${unseated.length === 1 ? '' : 's'} did not fit ` +
          `this prompt's context budget and ${unseated.length === 1 ? 'is' : 'are'} NOT included ` +
          `above: ${named.map((d) => `${d.title}${originSuffix(d.url)}`).join(', ')}` +
          `${rest > 0 ? `, and ${rest} more` : ''}. Treat what you were given as incomplete, and ` +
          `say so in your output if the missing text would change your conclusion.`,
      )
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
function technicalContextSection(context: AgentRunContext): string {
  if (!context.block.technical) return ''
  return [
    '',
    'This task is flagged TECHNICAL (a refactor / non-functional / internal change). Treat',
    'the task definition and any incorporated requirements above as the PRIMARY source of',
    'truth, and the committed `spec/` only as a regression-spotting reference — do not',
    'invent behaviour to satisfy a spec this task did not set out to change.',
  ].join('\n')
}

/**
 * Render the CHOSEN IMPLEMENTATION APPROACH section when the fork-decision phase resolved to
 * a human choice (see {@link AgentRunContext.implementationChoice}), or an empty string
 * otherwise. It pins the chosen approach as a binding directive and names the rejected
 * alternatives so the Coder does not drift back into them. Only the build user prompt appends
 * it — the matching static rule lives in the BUILD system prompt. Empty (so byte-identical) on
 * every run where no fork was chosen (skipped / single path / not configured).
 */
function implementationChoiceSection(context: AgentRunContext): string {
  const choice = context.implementationChoice
  if (!choice) return ''
  const lines = [
    '',
    'CHOSEN IMPLEMENTATION APPROACH (binding — a human picked this before you started):',
    `Title: ${choice.title}`,
    '',
    choice.approach,
  ]
  if (choice.note && choice.note.trim().length > 0) {
    lines.push('', `Steering note from the human: ${choice.note.trim()}`)
  }
  if (choice.alternativesConsidered.length > 0) {
    lines.push(
      '',
      `Alternatives considered and rejected: ${choice.alternativesConsidered.join('; ')}.`,
      'Implement the chosen approach faithfully. Do NOT drift into a rejected alternative; if',
      'the chosen approach proves unworkable, surface a follow-up rather than silently switching.',
    )
  }
  return lines.join('\n')
}

/** Render the built-out user prompt for a standard phase from the run context. */
export function renderStandardUserPrompt(
  phase: StandardPhase,
  context: AgentRunContext,
  opts: { materialized?: boolean } = {},
): string {
  const rendered =
    USER_TEMPLATES[phase](toView(context)) +
    // Preset steering FIRST — it frames the agent's role for this initiative before the task
    // specifics. Empty (so byte-identical) on every non-initiative run.
    initiativePresetSection(context) +
    // What system this work belongs to, BEFORE the linked context and the environment: it frames
    // everything that follows, and it is the section that states its own absence.
    ownServiceSection(context) +
    // The operation's per-case parameters, right after the block context they qualify and before
    // the linked context. Empty (so byte-identical) on every run of a built-in task type.
    customTaskTypeSection(context) +
    linkedContextSection(context, opts) +
    // The design PICTURES, right after the linked context whose textual design description they
    // are the other half of. States its own absence-with-a-cause, so it is never conditional here.
    designImagesSection(context) +
    environmentSection(context) +
    involvedServicesSection(context) +
    // Only the implementer (build) acts on the TECHNICAL marker — its system prompt carries
    // the matching rule. The architect/reviewer have no such rule, so don't change their prompt.
    (phase === 'build' ? technicalContextSection(context) : '') +
    // Only the implementer (build) acts on a chosen implementation fork; its system prompt
    // carries the matching rule. Empty on every non-fork run.
    (phase === 'build' ? implementationChoiceSection(context) : '')
  // Collapse the blank lines that conditionals leave behind, then trim.
  return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

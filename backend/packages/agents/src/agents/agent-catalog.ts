import type { AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  acceptanceSystemPrompt,
  testApproachSection,
  testTargetSection,
} from './acceptance-prompts.js'
import { companionSystemPrompt } from './companion-prompts.js'
import { companionTargets, isCompanionKind } from './companions.js'
import { READ_ONLY_GUARDRAIL, isReadOnlyAgentKind } from './read-only.js'
import { businessLogicSystemPrompt } from './business-logic-prompts.js'
import { mockSystemPrompt } from './mock-prompts.js'
import { registeredSystemPrompt, registeredUserPrompt } from './registry.js'
import {
  environmentSection,
  linkedContextSection,
  phaseForKind,
  renderStandardUserPrompt,
  standardSystemPrompt,
} from './standard-prompts.js'

// Role definitions and prompt construction for the built-in agent kinds. These
// turn an agent kind + block context into the system/user prompts handed to the
// LLM. The four standard solution phases — design (architect), build (coder),
// review (reviewer) and test (tester) — use the built-out prompts in
// ./standard-prompts; the acceptance-testing track (acceptance, playwright) uses
// the built-out prompts in ./acceptance-prompts; the mock builder (mocker) uses
// the built-out prompt in ./mock-prompts; the business-logic / domain-rules track
// (business-documenter, business-reviewer) uses the built-out prompts in
// ./business-logic-prompts; the remaining kinds use the thin roles below, and
// custom agent kinds (free-form ids) fall back to a generic role.

const ROLES: Partial<Record<AgentKind, string>> = {
  researcher:
    'You are a technical researcher. Investigate prior art, libraries and constraints relevant to the building block and summarise concrete recommendations.',
  // Opens the tech-debt recurring pipeline. Clones the repo and inspects it for the
  // highest-value technical debt; it MUST be read-only (make no edits / commits) and
  // produce a single, prioritized, actionable markdown report that a downstream
  // `tracker` step files as an issue and a `coder` step then implements.
  analysis:
    'You are a senior engineer performing a technical-debt audit of this service. Explore the repository (build scripts, dependencies, tests, hot spots, TODO/FIXME markers, outdated patterns) and identify the highest-value technical debt to address now. Produce a single prioritized markdown report: for each item give a short title, the affected area, why it matters, and a concrete suggested fix. Lead with the one item most worth doing first, since it will be turned into a tracked issue and implemented.',
  documenter:
    'You are a technical writer. Produce concise developer documentation and a usage example for the building block.',
  integrator:
    'You are an integration engineer. Describe how to wire this building block into the surrounding system, including contracts and rollout.',
  // Runs before the architect: reviews the collected CONTEXT (the linked-prose brief)
  // and surfaces what would block confident implementation. Its findings are presented
  // to a human at an approval gate (to reject items or supply missing information)
  // before the architect proceeds, so it must read as a clear, editable list.
  'requirements-review':
    'You are a meticulous product / requirements analyst reviewing the collected requirements for a single building block before an engineer designs or builds it. Surface everything that would block confident implementation: missing information (gaps), ambiguities that need clarification, unstated assumptions, risks, and open questions. Be specific, concrete and actionable, and phrase each item so a product owner can answer it directly. Do NOT invent answers or requirements. Group your findings under clear headings and present a concise, readable markdown list — a human will review and edit it before the architect proceeds.',
  // Runs in a container against the PR head branch when CI is red. It must make the
  // failing build/tests pass with the smallest correct change and push to the same
  // branch (no new branch / PR) so CI re-runs.
  'ci-fixer':
    'You are a CI/build engineer. The pull request on this branch has failing CI. Reproduce the failure locally (run the project build / tests), diagnose the root cause, and make the minimal correct change to get every check passing. Do not disable or skip tests to make them pass. Commit your fix to the current branch.',
  // Runs in a container against the PR head branch when the PR conflicts with its
  // base. The harness has already merged the base in, leaving conflict markers; the
  // agent resolves every one and the harness completes the merge commit + pushes to
  // the same branch (no new branch / PR).
  'conflict-resolver':
    'You are a software engineer resolving a merge conflict. The base branch has been merged into this pull-request branch, leaving Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in one or more files. Find every conflicted file, understand both sides of each conflict, and edit the files to a correct, coherent result that preserves the intent of BOTH the PR changes and the base changes — never just discard one side. Remove all conflict markers and leave the project building. Do not open a new branch or PR; commit your resolution to the current branch.',
  // Runs in a container against the PR head branch as the final pipeline step. It
  // ONLY assesses — it must not modify the repo — and returns a JSON score object.
  merger:
    'You are a release manager assessing a pull request before merge. Inspect the change against the base branch and judge three axes, each from 0 (trivial/safe) to 1 (severe): complexity, risk and impact. Be conservative. Make no commits. Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, no code fences.',
}

export function systemPromptFor(kind: AgentKind): string {
  const base = baseSystemPromptFor(kind)
  // Read-only kinds (architect, analysis) explore a real checkout but must never edit
  // it; append the shared guardrail so the harness `/explore` run stays edit-free.
  return isReadOnlyAgentKind(kind) ? `${base}\n\n${READ_ONLY_GUARDRAIL}` : base
}

function baseSystemPromptFor(kind: AgentKind): string {
  // Companion kinds (reviewer, architect-companion, spec-companion, …) win over every
  // built-in track: they grade a prior step's output and return a JSON rating.
  const companion = companionSystemPrompt(kind)
  if (companion) return companion
  const phase = phaseForKind(kind)
  if (phase) return standardSystemPrompt(phase)
  const acceptance = acceptanceSystemPrompt(kind)
  if (acceptance) return acceptance
  const mock = mockSystemPrompt(kind)
  if (mock) return mock
  const businessLogic = businessLogicSystemPrompt(kind)
  if (businessLogic) return businessLogic
  // Custom kinds registered by a deployment (e.g. a proprietary org package) win over
  // the generic fallback below, but never shadow the built-in tracks above.
  const registered = registeredSystemPrompt(kind)
  if (registered !== undefined) return registered
  return (
    ROLES[kind] ??
    `You are the "${kind}" agent. Do your part of the work for the given building block and report the result concisely.`
  )
}

/**
 * When a human requested changes on this step's gated proposal, append their
 * feedback and the previous proposal so the agent revises rather than restarts.
 * Applied to every inline agent kind (standard-phase and generic alike).
 */
function withRevision(prompt: string, context: AgentRunContext): string {
  const revision = context.revision
  if (!revision) return prompt
  const lines = [
    prompt,
    '',
    'A human reviewed your previous proposal and requested changes. Revise that',
    'proposal to address their feedback — keep what still holds, change what they',
    'flagged. Do not start from scratch.',
    '',
    'Your previous proposal:',
    revision.previousProposal || '(empty)',
    '',
    'Reviewer feedback:',
    revision.feedback || '(none given)',
  ]
  // Per-block comments the reviewer left on specific parts of the proposal. Each
  // quotes the exact text it targets, so the agent can locate and revise it.
  if (revision.comments?.length) {
    lines.push('', 'Comments on specific parts of your proposal:')
    for (const c of revision.comments) {
      lines.push(
        '',
        'On this part:',
        c.quotedSource || '(empty)',
        'Comment:',
        c.body || '(none given)',
      )
    }
  }
  return lines.join('\n')
}

/** Build the user prompt from the block context and the run so far. */
export function userPromptFor(context: AgentRunContext): string {
  return withRevision(buildBaseUserPrompt(context), context)
}

function buildBaseUserPrompt(context: AgentRunContext): string {
  // Standard phases get their built-out, templated user prompt.
  const phase = phaseForKind(context.agentKind)
  if (phase) return renderStandardUserPrompt(phase, context)

  // A registered custom kind may supply its own user prompt; otherwise it falls through
  // to the generic block-context prompt below, like any other non-standard-phase kind.
  const registered = registeredUserPrompt(context)
  if (registered !== undefined) return registered

  const { block, pipelineName, priorOutputs, decisions, resolvedDecision } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Block: ${block.title} (${block.type})`,
    `Description: ${block.description || '(none provided)'}`,
  ]
  // A companion grades a specific preceding producer; name it explicitly so the
  // model rates the right output rather than guessing among the prior-agent sections.
  const companionTarget = companionTargetSection(context)
  if (companionTarget) lines.push(companionTarget)
  const linked = linkedContextSection(context)
  if (linked) lines.push(linked)
  const envSection = environmentSection(context)
  if (envSection) lines.push(envSection)
  const approachSection = testApproachSection(context)
  if (approachSection) lines.push(approachSection)
  const targetSection = testTargetSection(context)
  if (targetSection) lines.push(targetSection)
  const allDecisions = resolvedDecision ? [...decisions, resolvedDecision] : decisions
  if (allDecisions.length) {
    lines.push('', 'Resolved decisions:')
    for (const d of allDecisions) lines.push(`- ${d.question} → ${d.chosen}`)
  }
  if (priorOutputs.length) {
    lines.push('', 'Work from earlier agents in this pipeline:')
    for (const p of priorOutputs) {
      lines.push(`### ${p.agentKind}`, p.output)
    }
  }
  lines.push('', 'Produce your contribution. Be concise and concrete.')
  return lines.join('\n')
}

/**
 * For a companion step, name the specific producer output it must grade: the NEAREST
 * preceding step whose kind is one of the companion's targets. Without this the model
 * has to infer which "### <agentKind>" section is the one under review — fine when the
 * producer is adjacent, ambiguous when other steps sit in between. Undefined for
 * non-companion kinds or when no target output is present yet.
 */
function companionTargetSection(context: AgentRunContext): string | undefined {
  if (!isCompanionKind(context.agentKind)) return undefined
  const targets = companionTargets(context.agentKind)
  for (let i = context.priorOutputs.length - 1; i >= 0; i--) {
    const produced = context.priorOutputs[i]!
    if (targets.includes(produced.agentKind)) {
      return (
        `You are grading the output of the \`${produced.agentKind}\` step (shown under ` +
        `"### ${produced.agentKind}" below). Base your rating on THAT output.`
      )
    }
  }
  return undefined
}

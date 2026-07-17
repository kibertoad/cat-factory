import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { PLATFORM_DELIVERY_CONTRACT } from '../prompts/delivery-contract.js'
import { STANDARDS_FOOTER } from '../prompts/shared.js'
import { linkedContextSection } from '../prompts/standard.js'

// ---------------------------------------------------------------------------
// The `skill` agent kind — ONE generic, parametrized container-coding agent that executes a
// repo-sourced Claude Skill (docs/initiatives/repo-skills.md). A team authors skills in a repo
// (`<skill>/SKILL.md` + sibling resources); the account syncs them into its skill catalog
// (slice 1), and a pipeline step of this kind runs one — selected NOT by a bespoke per-skill
// agent kind, but by the step's `stepOptions.skillId`. That per-step id is resolved to the skill
// (instructions + resource bodies at the pinned commit) by the engine's `skillResolver` and
// placed on `context.skill`; the container executor renders it HARNESS-AWARE (native
// `~/.claude/skills/<name>/` for the claude-code harness, prompt + `.cat-context/skill/*` for
// Pi/codex). So this kind's own prompt is deliberately SKILL-AGNOSTIC — the picked skill's
// instructions are injected around it by the executor, not baked in here.
//
// Why one parametrized kind and not a kind-per-skill: `AgentKindRegistry` is deployment-static
// composition-root data, while skills are per-tenant runtime data — a dynamic kind per skill
// would leak tenant state into an app-owned registry and break the snapshot/palette contract.
// `stepOptions` is the designated extensible per-step params seam.
//
// It runs the SAME generic container-coding lifecycle as `coder` / `code-commenter`
// (`buildRegisteredAgentBody`), so it needs no bespoke harness handler beyond the claude-code
// native-skills write. Its product is a pushed commit (or a clean no-op), so — like the coder /
// code-commenter — it must NOT carry `FINAL_ANSWER_IN_REPLY` (`applySurfaceDirectives` withholds
// it from a `container-coding` kind). `noChangesTolerated` so an analysis- or advisory-only skill
// that legitimately produces no diff is a clean non-event, not a failure. `pr-or-work` clone:
// amend the block's PR in place when one exists (a skill running after the coder), else branch
// off base and open its own PR (a standalone skill pipeline).
// ---------------------------------------------------------------------------

export const SKILL_AGENT_KIND = 'skill'

const SKILL_SYSTEM_PROMPT = [
  'You are a senior engineer executing a specific SKILL — a procedural playbook your team',
  'authored for this kind of work. The skill for this step is provided to you: either its',
  'instructions appear below, or it is installed as a Claude skill you must invoke. Read the',
  'skill first, then apply it faithfully to the task at hand — follow its steps, honour its',
  'constraints, and use any resource files it references. The skill is the authority on HOW to',
  'do the work; the task description below is WHAT to apply it to.',
  '',
  'If, after following the skill, there is genuinely nothing to change (the skill is advisory or',
  'the codebase already satisfies it), that is an acceptable outcome — do not invent a change to',
  'have something to commit.',
  '',
  PLATFORM_DELIVERY_CONTRACT,
  '',
  STANDARDS_FOOTER,
].join('\n')

function skillUserPrompt(context: AgentRunContext): string {
  const lines = [
    `Pipeline: ${context.pipelineName}`,
    ...(context.skill ? [`Skill: ${context.skill.name}`] : []),
    `Task: ${context.block.title}`,
    `Brief: ${context.block.description?.trim() || '(none provided — infer the scope from the title and the skill)'}`,
  ]
  const linked = linkedContextSection(context, { materialized: true })
  if (linked) lines.push(linked)
  if (context.priorOutputs.length) {
    lines.push('', 'Work from earlier steps in this pipeline (build on it, do not repeat it):')
    for (const p of context.priorOutputs) lines.push(`### ${p.agentKind}`, p.output ?? '')
  }
  lines.push(
    '',
    'Apply the skill to this task. The platform commits your changes — amending this task’s',
    'existing pull request when there is one, or opening a new one otherwise — so do not run git',
    'yourself.',
  )
  return lines.filter(Boolean).join('\n')
}

/** The generic skill-execution kind (repo-skills initiative slice 2). */
export const SKILL_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: SKILL_AGENT_KIND,
    systemPrompt: SKILL_SYSTEM_PROMPT,
    userPrompt: skillUserPrompt,
    agent: {
      surface: 'container-coding',
      clone: { branch: 'pr-or-work' },
      noChangesTolerated: true,
    },
    presentation: {
      label: 'Skill',
      icon: 'i-lucide-book-open-check',
      color: '#0ea5e9',
      description:
        'Runs a repo-sourced Claude Skill (a procedural playbook your team authored) against a task, committing whatever changes the skill prescribes.',
      category: 'build',
    },
  },
]

/**
 * Register the skill kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerSkillAgent(registry: AgentKindRegistry): void {
  registry.registerAll(SKILL_AGENT_KINDS)
}

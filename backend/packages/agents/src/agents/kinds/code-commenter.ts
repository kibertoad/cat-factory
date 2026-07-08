import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { DOC_AWARE_TRAIT } from './traits.js'
import { PLATFORM_DELIVERY_CONTRACT } from '../prompts/delivery-contract.js'
import { STANDARDS_FOOTER } from '../prompts/shared.js'
import { linkedContextSection } from '../prompts/standard.js'

// ---------------------------------------------------------------------------
// `code-commenter` — a single, context-parametrized agent that keeps a codebase's in-source
// comments relevant, accurate and up-to-date: it adds WHY-not-what comments where they are
// missing, updates ones that have drifted from the code, and DELETES noise comments that merely
// restate what the code already says — all comment-only, with NO behaviour change.
//
// It serves BOTH use-cases from one kind, differing only in what its commit lands on (resolved by
// the engine at dispatch from whether the block already has a PR — see the `pr-or-work` clone):
//   1. Business-as-usual hygiene (the common case we optimise for): a step in the standard build
//      pipelines that runs AFTER the coder, amending that task's existing PR in place so the
//      well-commented code ships in the SAME pull request the merger merges.
//   2. Broad sweep of an existing/legacy codebase (e.g. framed as an initiative that spawns one
//      block per module, or the standalone `pl_code_comments` pipeline): no prior PR, so it
//      branches off base and opens its OWN pull request per unit of work.
//
// It is the ONE genuinely-new capability the docs-refresh preset needs: every other doc type it
// authors is a document a writer already produces (READMEs and diagrams reuse `doc-writer`; a
// Mermaid `.md` is just Markdown; business rules reuse `business-documenter`). Comments are the
// opposite — an IN-PLACE edit of existing `.ts`/`.py`/… files, comment-only, that must not change
// behaviour. That directly contradicts `doc-writer`'s load-bearing contract ("write ONLY that
// document — do not touch code"), so no document writer can express it, and `coder` (whose role is
// to CHANGE code) would fight its own prompt. Hence a dedicated kind with a hard comment-only
// contract; the pipeline's `ci` step is the backstop that proves the diff is behaviour-neutral.
//
// It runs the SAME generic container-coding lifecycle as `doc-writer` / `coder`
// (`buildRegisteredAgentBody`), so it needs NO bespoke harness handler and NO executor-harness
// image bump. Its product is a pushed commit, so — like the coder / doc-writer — it must NOT carry
// `FINAL_ANSWER_IN_REPLY` (`applySurfaceDirectives` already withholds it from a `container-coding`
// kind). It is `doc-aware` so the engine folds the block's writing-style fragments (anti-LLM-isms,
// concise & actionable) into its prompt — comments are writing, so the same style guidance applies
// (the `code-aware` analogue for authored text).
//
// See `docs/initiatives/initiative-presets-and-docs-refresh.md` (slice 7).
// ---------------------------------------------------------------------------

export const CODE_COMMENTER_KIND = 'code-commenter'

/** The docs-refresh spawn (slice 8) sets this per item (the module to comment); other runs leave it unset. */
function targetPath(context: AgentRunContext): string | undefined {
  return context.block.taskTypeFields?.targetPath?.trim() || undefined
}

const CODE_COMMENTER_SYSTEM_PROMPT = [
  'You are a senior engineer keeping a codebase’s in-source comments relevant, accurate and',
  'up-to-date. Add and clarify comments that explain the WHY — intent, invariants, trade-offs,',
  'non-obvious constraints and gotchas — not the what a reader can already see from the code itself.',
  '',
  'Absolute rule — NO behaviour change:',
  '- Touch ONLY comments and docstrings. Do not change any executable code: no edits to logic,',
  '  control flow, signatures, names, imports, or types, and no reformatting or reordering of code.',
  '  The build, the linters and the tests must pass unchanged — the pipeline’s CI step verifies',
  '  this, so a comment-only diff is the whole deliverable.',
  '',
  'Maintain what is already there — do not only add:',
  '- Update comments that have drifted from the code they describe so they are accurate again, and',
  '  fix or remove ones that are now wrong or misleading (a stale comment is worse than none).',
  '- DELETE noise comments that merely restate what the code already says — a comment that just',
  '  narrates the next line (`// increment i`), a banner/section divider that adds nothing, or a',
  '  docstring that only echoes the signature. They add maintenance cost and drown the comments',
  '  that matter. Delete commented-out / dead code only when it is plainly obsolete; when unsure,',
  '  leave it.',
  '',
  'Approach:',
  '- Read the code first, then focus on what is hardest to understand: complex algorithms, subtle',
  '  concurrency or ordering, workarounds, security- or money-sensitive paths, and public APIs that',
  '  lack a docstring. Do not comment self-evident lines.',
  '- Match the file’s existing comment style and the language’s docstring convention. Keep comments',
  '  concise and accurate; a wrong comment is worse than none.',
  '',
  PLATFORM_DELIVERY_CONTRACT,
  '',
  STANDARDS_FOOTER,
].join('\n')

function codeCommenterUserPrompt(context: AgentRunContext): string {
  const lines = [
    `Pipeline: ${context.pipelineName}`,
    `Task: ${context.block.title}`,
    `Brief: ${context.block.description?.trim() || '(none provided — infer the scope from the title and the code)'}`,
  ]
  const path = targetPath(context)
  const onPr = Boolean(context.block.pullRequest?.branch)
  if (path) {
    lines.push(`Comment the code under: \`${path}\`.`)
  } else if (onPr) {
    // BAU pipeline step: a PR is already open (the coder's). Scope the pass to the code this task
    // changed so it polishes THIS change rather than wandering the whole repo.
    lines.push(
      'Focus on the files this pull request changes — that is the code whose comments need bringing up to standard.',
    )
  }
  const linked = linkedContextSection(context, { materialized: true })
  if (linked) lines.push(linked)
  if (context.priorOutputs.length) {
    lines.push('', 'Work from earlier steps in this pipeline (build on it, do not repeat it):')
    for (const p of context.priorOutputs) lines.push(`### ${p.agentKind}`, p.output ?? '')
  }
  lines.push(
    '',
    'Add and clarify WHY-not-what comments on the hardest-to-follow code in scope, update comments',
    'that have drifted, and remove noise comments that only restate the code. Change comments and',
    'docstrings ONLY — no code, formatting or behaviour changes (CI will verify). The platform',
    'commits your changes — amending this task’s existing pull request when there is one, or opening',
    'a new one otherwise — so do not run git yourself.',
  )
  return lines.filter(Boolean).join('\n')
}

/** The in-source comment maintainer kind (initiative-presets slice 7). */
export const CODE_COMMENTER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: CODE_COMMENTER_KIND,
    systemPrompt: CODE_COMMENTER_SYSTEM_PROMPT,
    userPrompt: codeCommenterUserPrompt,
    // `pr-or-work`: amend the block's PR in place when one exists (a BAU pipeline step running
    // after the coder), else branch off base and open its own PR (a standalone / initiative sweep).
    // The pipeline's CI tail proves the diff is behaviour-neutral either way. `noChangesTolerated`
    // so a run that finds the comments already in good shape is a clean non-event, not a failure —
    // comment hygiene legitimately produces nothing sometimes (and the in-place PR path tolerates a
    // no-op regardless).
    agent: {
      surface: 'container-coding',
      clone: { branch: 'pr-or-work' },
      noChangesTolerated: true,
    },
    // Doc-aware: the engine folds the block's writing-style fragments (anti-LLM-isms, concise &
    // actionable) into the prompt — comments are writing, so the style guidance applies.
    traits: [DOC_AWARE_TRAIT],
    presentation: {
      label: 'Code Commenter',
      icon: 'i-lucide-message-square-code',
      color: '#818cf8',
      description:
        'Keeps in-source comments relevant and up-to-date: adds why-not-what comments, fixes ones that have drifted from the code, and removes noise, with no behaviour change.',
      category: 'docs',
    },
  },
]

/**
 * Register the code-commenter kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerCodeCommenterAgent(registry: AgentKindRegistry): void {
  registry.registerAll(CODE_COMMENTER_AGENT_KINDS)
}

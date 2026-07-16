import { prReviewAgentOutputSchema } from '@cat-factory/contracts'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The `pr-reviewer` agent kind — a deep, token-bounded review of an EXISTING open
// pull request, modelled on Claude Code's `/review` but designed to scale to PRs
// with hundreds of changed files.
//
// It is a `container-explore` (read-only) clone of the PR head branch. The prompt
// makes the SCALE strategy explicit: rather than reading the entire diff into one
// context (which blows up on a huge PR), the reviewer first SLICES the change into
// cohesive, inherently-linked groups (a refactor + its call sites + its tests) from
// the cheap `git diff --name-status` + `--stat` signals, then reviews ONE slice at a
// time — reading only that slice's files — and finally aggregates + prioritizes the
// findings by severity. Pi's agentic tool loop keeps each slice's context bounded, so
// token usage scales with the slice budget, not the whole PR.
//
// The structured JSON (slices + severity-ordered findings) is recorded on the step as
// `result.custom` and rendered by the dedicated `pr-review` window: the run parks for a
// human to multi-select which findings matter, then resolve one of three ways — `finish`
// (record the selection), `fix` (feed the selected findings to a Fixer that commits fixes
// onto the PR branch) or `post` (publish them as inline PR review comments). See
// backend/docs/adr/0023-pr-deep-review.md.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically
// for a registered `container-explore` kind (see `applySurfaceDirectives`), so the
// prompt below is only the core role.
// ---------------------------------------------------------------------------

export const PR_REVIEWER_KIND = 'pr-reviewer'

/**
 * The reviewer's structured output. The lenient (`v.fallback`) slice/finding shape is the
 * SINGLE source of truth in `@cat-factory/contracts` (`prReviewAgentOutputSchema`) — shared
 * with the engine's coercion onto `step.prReview` and the selection UI — so a partially-
 * malformed reply degrades to sensible defaults rather than failing the run.
 */
export const prReview = defineStructuredOutput(prReviewAgentOutputSchema)

export type PrReviewOutput = ReturnType<typeof prReview.parse>

export const PR_REVIEWER_SYSTEM_PROMPT =
  'You are a meticulous senior code reviewer performing a DEEP review of an open pull request. ' +
  'The task names the pull request to review — its number (e.g. #123) and URL. Fetch its head ' +
  'into the checkout and diff it against the base branch:\n' +
  '  git fetch origin pull/<number>/head:pr-head\n' +
  '  git diff --name-status origin/<base>...pr-head   # <base> = the default branch unless told otherwise\n' +
  'The PR may be large (hundreds of changed files), so review it in a way that stays within a ' +
  'bounded context rather than reading the whole diff at once:\n' +
  '1. First list the changed files cheaply with the `--name-status` + `--stat` diffs above. ' +
  'Do NOT read every patch yet.\n' +
  '2. Group the changed files into COHESIVE slices — files that are inherently linked and should ' +
  'be reviewed together (a refactor and its call sites and its tests; a schema change and its ' +
  'migration and its mapper). A slice is a unit you can review with full understanding on its own.\n' +
  '3. Review ONE slice at a time: read only that slice’s files and their diffs, assess them for ' +
  'correctness, security, performance, maintainability, tests and risk, then move to the next ' +
  'slice. Keeping to one slice at a time is what keeps the review token-bounded on a huge PR.\n' +
  '4. Aggregate every slice’s findings into ONE list, ordered by severity (blocker → nit), and ' +
  'drop duplicates.\n' +
  'For each finding give the repo-relative file path, the line it anchors to (on the PR head, ' +
  'side "RIGHT", unless it concerns a removed/base line), a severity, a category, a short title, ' +
  'a precise detail, and — when you can — a concrete suggested fix. Reference the specific code ' +
  'each finding concerns; distinguish must-fix issues (blocker/high) from optional suggestions ' +
  '(low/nit). If the PR is sound, say so in the summary rather than inventing problems. ' +
  'Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "summary": "one-paragraph overall assessment",\n' +
  '  "slices": [{ "title": "short name", "rationale": "why these files belong together", "paths": ["a/b.ts"] }],\n' +
  '  "findings": [{\n' +
  '    "path": "repo/relative/path.ts",\n' +
  '    "line": 42,\n' +
  '    "side": "RIGHT",\n' +
  '    "severity": "blocker | high | medium | low | nit",\n' +
  '    "category": "correctness | security | performance | maintainability | style | test | other",\n' +
  '    "title": "short headline",\n' +
  '    "detail": "the full finding, in prose",\n' +
  '    "suggestedFix": "a concrete suggested change, when applicable"\n' +
  '  }]\n' +
  '}'

export const PR_REVIEWER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: PR_REVIEWER_KIND,
    systemPrompt: PR_REVIEWER_SYSTEM_PROMPT,
    // Read-only FULL clone of the repo's BASE (default) branch — a review task targets an
    // EXISTING external PR that the run never opened, so there is no work branch to clone; the
    // prompt fetches the PR head by number (`git fetch origin pull/<n>/head`) and diffs it against
    // the base. Full history so the base..head diff resolves. `agent.output` is derived from the schema.
    agent: { surface: 'container-explore', clone: { branch: 'base', full: true } },
    structuredOutput: prReview,
    presentation: {
      label: 'PR Reviewer',
      icon: 'i-lucide-clipboard-check',
      color: '#6366f1',
      description:
        'Deep, token-bounded review of an open pull request: slices a large diff into cohesive ' +
        'chunks, reviews each, and returns prioritized findings.',
      category: 'review',
      // Opens the dedicated PR-review window (findings grouped by slice + multi-select →
      // resolve) instead of the generic read-only JSON viewer. See PrReviewWindow.vue.
      resultView: 'pr-review',
    },
  },
]

/**
 * Register the pr-reviewer kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerPrReviewerAgent(registry: AgentKindRegistry): void {
  registry.registerAll(PR_REVIEWER_AGENT_KINDS)
}

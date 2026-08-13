import { type StandardPhase, phaseForKind, standardSystemPrompt } from '../prompts/standard.js'
import {
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from '../prompts/requirements.js'
import { CLARITY_REVIEW_SYSTEM_PROMPT, CLARITY_REWORK_SYSTEM_PROMPT } from '../prompts/clarity.js'
import {
  ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
} from '../prompts/brainstorm.js'
import { KAIZEN_SYSTEM_PROMPT } from '../prompts/kaizen.js'
import { FORK_PROPOSER_SYSTEM_PROMPT } from './fork-proposer.js'
import { FORK_CHAT_SYSTEM_PROMPT } from '../prompts/fork-decision.js'
import { JUDGE_SYSTEM_PROMPT } from '../prompts/judge.js'
import { isCompanionKind } from './companions.js'
import { SPEC_WRITER_SYSTEM_PROMPT } from './spec-blueprints.js'

// Versioned registry of the built-in agent system prompts. The goal is simple
// change management: every prompt the product ships is identified as
// `id@vN`, and the rule is "edit a prompt ⇒ bump its number". Benchmarks and
// any future audit can then attribute an outcome to the exact prompt that
// produced it, and a diff in a report makes a regression traceable to a version.
//
// The prompts under version control are listed in PROMPT_VERSIONS below; add more ids
// there as other prompts come under version control. The prompt TEXT lives next to the
// other prompts (../prompts/*); this file only versions it.

/** A prompt under version control: its stable id, integer version and text. */
export interface VersionedPrompt {
  id: string
  version: number
  text: string
}

/** The currently-shipping version of each numbered prompt. */
export const PROMPT_VERSIONS = {
  // v5 / v4 / v4: all three carry the shared `PRODUCT_SCOPE_BOUNDARY` — requirements review
  // settles the product/business layer only, and the technical layer is the Architect's and
  // Researcher's. Bumped together because the boundary only holds if all three honour it.
  //
  // This bump adds the `NO_ASSUMED_PRODUCT` rule (and, for the Writer, the matching rule against
  // searching the web for a product it had to guess at, plus the `groundedIn` provenance field) and
  // reorders each prompt so the role text precedes the platform-enforced directives — the split a
  // per-workspace override crosses. Every prompt in the flow bumps together for the same reason
  // the scope boundary does: an agent that keeps inventing a subject undoes the two that don't.
  // v6 / v5 on the reviewer and the Writer: the two-GROUP split is now something a person sees and
  // an unwatched run acts on, so both halves of it are stated in the prompts. The reviewer is told
  // that `autoAnswerable` decides WHO answers (and that a false positive is the invisible mistake);
  // the Writer additionally grades each suggestion with a `confidence` the unattended auto-answer
  // floor compares against. The rework prompt is unchanged and keeps v4: it folds settled answers
  // into a document and never sees either judgement.
  'requirement-review': { id: 'requirement-review', version: 6, text: REVIEW_SYSTEM_PROMPT },
  'requirement-rework': { id: 'requirement-rework', version: 4, text: REWORK_SYSTEM_PROMPT },
  'requirement-writer': { id: 'requirement-writer', version: 5, text: WRITER_SYSTEM_PROMPT },
  // v2 across the clarity + brainstorm prompts: same `NO_ASSUMED_PRODUCT` addition and the same
  // role/directives split.
  'clarity-review': { id: 'clarity-review', version: 2, text: CLARITY_REVIEW_SYSTEM_PROMPT },
  'clarity-rework': { id: 'clarity-rework', version: 2, text: CLARITY_REWORK_SYSTEM_PROMPT },
  'requirements-brainstorm': {
    id: 'requirements-brainstorm',
    version: 2,
    text: REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
  },
  'requirements-brainstorm-rework': {
    id: 'requirements-brainstorm-rework',
    version: 2,
    text: REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  },
  'architecture-brainstorm': {
    id: 'architecture-brainstorm',
    version: 2,
    text: ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  },
  'architecture-brainstorm-rework': {
    id: 'architecture-brainstorm-rework',
    version: 2,
    text: ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  },
  // v5: the build phase now distinguishes `established` (standing) from `aspirational`
  // (agreed-but-not-built) requirements in the committed `spec/`.
  // v6: the shared delivery contract states that commits are PUBLISHED as they are made, so the
  // agent adds commits rather than amending/resetting/rebasing ones it already made, a rule it
  // could not infer, since the checkpoint push that publishes them is invisible from inside the
  // container.
  build: { id: 'build', version: 6, text: standardSystemPrompt('build') },
  // Brought under version control alongside the implementation-state axis: the spec-writer now
  // emits `requirementItem.state`, and its output is the durable behaviour contract every later
  // step reads, so a change to it needs to be attributable like the standard phases. Numbering
  // starts at 1 — there is no earlier RECORDED version to succeed.
  'spec-writer': { id: 'spec-writer', version: 1, text: SPEC_WRITER_SYSTEM_PROMPT },
  review: { id: 'review', version: 2, text: standardSystemPrompt('review') },
  kaizen: { id: 'kaizen', version: 1, text: KAIZEN_SYSTEM_PROMPT },
  'fork-proposer': { id: 'fork-proposer', version: 1, text: FORK_PROPOSER_SYSTEM_PROMPT },
  'fork-chat': { id: 'fork-chat', version: 1, text: FORK_CHAT_SYSTEM_PROMPT },
  // v2: the summary is now rendered as markdown beside the `findings` list, so the prompt asks for
  // a short whole-verdict paragraph that does NOT restate the findings. Scoring is untouched.
  //
  // The number is the shipped prompt's IDENTITY (what a benchmark cell and the sandbox baseline
  // label attribute an outcome to); it does not re-key a Kaizen combo, because a judge is attached
  // to a step and is never a step's own `agentKind`, which is what `promptVersionForKind` reads.
  judge: { id: 'judge', version: 2, text: JUDGE_SYSTEM_PROMPT },
} as const satisfies Record<string, VersionedPrompt>

/** Ids of the prompts currently under version control. */
export type PromptId = keyof typeof PROMPT_VERSIONS

/**
 * The versioned prompt id for each STANDARD PHASE that is under version control. The
 * kind→phase mapping is owned by `STANDARD_PHASE_BY_KIND` (in ../prompts/standard), so we
 * derive a phase kind's prompt version from there rather than re-listing every kind here —
 * a new build/review-phase kind is then covered automatically. Phases without a numbered
 * prompt (`design`, `test`) are absent and resolve to 1.
 */
const PHASE_PROMPT_IDS: Partial<Record<StandardPhase, PromptId>> = {
  build: 'build',
  review: 'review',
}

/**
 * Versioned prompt id for the non-phase kinds whose prompt is under version control (these
 * have their own role prompts, not a standard phase).
 */
const NON_PHASE_PROMPT_IDS: Record<string, PromptId> = {
  'requirements-review': 'requirement-review',
  clarity: 'clarity-review',
  'fork-proposer': 'fork-proposer',
  'spec-writer': 'spec-writer',
}

/**
 * The versioned prompt id backing a kind's system prompt, or undefined when the kind's
 * prompt carries no number. The direct (non-phase) map wins, else the kind's standard phase
 * supplies it — the same two-step resolution {@link promptVersionForKind} does, hoisted out so
 * a caller that wants the `id@vN` LABEL (the prompt editor, naming the shipped revision an
 * override was forked from) doesn't have to re-derive the id from a bare version number.
 *
 * A COMPANION resolves to no id, and that exclusion is load-bearing rather than tidy-up:
 * `baseSystemPromptFor` gives every companion the shared COMPANION prompt, which wins over any
 * built-in track, so the `reviewer` (the one companion that is also listed in the standard-phase
 * map, under `review`) does not send the `review` prompt at all. Answering `review@vN` for it named
 * a revision of TEXT IT NEVER RUNS: the editor showed that label as the baseline an override was
 * forked from, and a Kaizen combo re-keyed on edits to a prompt the step never saw while ignoring
 * edits to the one it did. The companion prompt is not under version control (it is composed per
 * kind, from the pairing's own `reviews` label), so "no number" is the honest answer until it is.
 */
export function promptIdForKind(kind: string): PromptId | undefined {
  const direct = NON_PHASE_PROMPT_IDS[kind]
  if (direct) return direct
  if (isCompanionKind(kind)) return undefined
  const phase = phaseForKind(kind as Parameters<typeof phaseForKind>[0])
  return phase ? PHASE_PROMPT_IDS[phase] : undefined
}

/**
 * The prompt version for a step's agent kind, used as the "prompt" dimension of a
 * Kaizen `(prompt, agent, model)` combo. Bumping a kind's numbered prompt (in
 * {@link PROMPT_VERSIONS}) changes the combo key, so a previously-verified combo is
 * re-graded against the new prompt. Kinds whose prompt is not under version control
 * (e.g. the `design`/`test` phases and bespoke kinds) resolve to 1 — their combo key is
 * stable because there is no numbered prompt to bump.
 */
export function promptVersionForKind(kind: string): number {
  const id = promptIdForKind(kind)
  return id ? PROMPT_VERSIONS[id].version : 1
}

/** The current versioned prompt for an id. */
export function promptVersion(id: PromptId): VersionedPrompt {
  return PROMPT_VERSIONS[id]
}

/** The canonical `id@vN` label for a prompt id (or an explicit version). */
export function promptVersionLabel(id: string, version?: number): string {
  const v = version ?? (id in PROMPT_VERSIONS ? PROMPT_VERSIONS[id as PromptId].version : 1)
  return `${id}@v${v}`
}

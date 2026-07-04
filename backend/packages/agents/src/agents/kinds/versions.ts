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
  'requirement-review': { id: 'requirement-review', version: 2, text: REVIEW_SYSTEM_PROMPT },
  'requirement-rework': { id: 'requirement-rework', version: 2, text: REWORK_SYSTEM_PROMPT },
  'requirement-writer': { id: 'requirement-writer', version: 2, text: WRITER_SYSTEM_PROMPT },
  'clarity-review': { id: 'clarity-review', version: 1, text: CLARITY_REVIEW_SYSTEM_PROMPT },
  'clarity-rework': { id: 'clarity-rework', version: 1, text: CLARITY_REWORK_SYSTEM_PROMPT },
  'requirements-brainstorm': {
    id: 'requirements-brainstorm',
    version: 1,
    text: REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
  },
  'requirements-brainstorm-rework': {
    id: 'requirements-brainstorm-rework',
    version: 1,
    text: REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  },
  'architecture-brainstorm': {
    id: 'architecture-brainstorm',
    version: 1,
    text: ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  },
  'architecture-brainstorm-rework': {
    id: 'architecture-brainstorm-rework',
    version: 1,
    text: ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  },
  build: { id: 'build', version: 3, text: standardSystemPrompt('build') },
  review: { id: 'review', version: 2, text: standardSystemPrompt('review') },
  kaizen: { id: 'kaizen', version: 1, text: KAIZEN_SYSTEM_PROMPT },
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
  const direct = NON_PHASE_PROMPT_IDS[kind]
  if (direct) return PROMPT_VERSIONS[direct].version
  const phase = phaseForKind(kind as Parameters<typeof phaseForKind>[0])
  const phaseId = phase ? PHASE_PROMPT_IDS[phase] : undefined
  return phaseId ? PROMPT_VERSIONS[phaseId].version : 1
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

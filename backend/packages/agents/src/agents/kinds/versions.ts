import { standardSystemPrompt } from '../prompts/standard.js'
import {
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from '../prompts/requirements.js'
import { CLARITY_REVIEW_SYSTEM_PROMPT, CLARITY_REWORK_SYSTEM_PROMPT } from '../prompts/clarity.js'
import { KAIZEN_SYSTEM_PROMPT } from '../prompts/kaizen.js'

// Versioned registry of the built-in agent system prompts. The goal is simple
// change management: every prompt the product ships is identified as
// `id@vN`, and the rule is "edit a prompt ⇒ bump its number". Benchmarks and
// any future audit can then attribute an outcome to the exact prompt that
// produced it, and a diff in a report makes a regression traceable to a version.
//
// We start by numbering the three prompts the benchmark harness exercises —
// the requirement reviewer, the builder (coder) and the code reviewer — all at
// v1. Add more ids here as other prompts come under version control. The prompt
// TEXT lives next to the other prompts (../prompts/*); this file only versions it.

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
  'requirement-writer': { id: 'requirement-writer', version: 1, text: WRITER_SYSTEM_PROMPT },
  'clarity-review': { id: 'clarity-review', version: 1, text: CLARITY_REVIEW_SYSTEM_PROMPT },
  'clarity-rework': { id: 'clarity-rework', version: 1, text: CLARITY_REWORK_SYSTEM_PROMPT },
  build: { id: 'build', version: 3, text: standardSystemPrompt('build') },
  review: { id: 'review', version: 2, text: standardSystemPrompt('review') },
  kaizen: { id: 'kaizen', version: 1, text: KAIZEN_SYSTEM_PROMPT },
} as const satisfies Record<string, VersionedPrompt>

/** Ids of the prompts currently under version control. */
export type PromptId = keyof typeof PROMPT_VERSIONS

/**
 * Best-effort map from an agent KIND to the versioned prompt id that drives it, for
 * the kinds whose prompt is under version control. Kinds absent here have no numbered
 * prompt yet and resolve to version 1 (see {@link promptVersionForKind}).
 */
const KIND_PROMPT_IDS: Record<string, PromptId> = {
  coder: 'build',
  build: 'build',
  reviewer: 'review',
  review: 'review',
  'requirements-review': 'requirement-review',
  clarity: 'clarity-review',
}

/**
 * The prompt version for a step's agent kind, used as the "prompt" dimension of a
 * Kaizen `(prompt, agent, model)` combo. Bumping a kind's numbered prompt (in
 * {@link PROMPT_VERSIONS}) changes the combo key, so a previously-verified combo is
 * re-graded against the new prompt. Kinds without a numbered prompt resolve to 1.
 */
export function promptVersionForKind(kind: string): number {
  const id = KIND_PROMPT_IDS[kind]
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

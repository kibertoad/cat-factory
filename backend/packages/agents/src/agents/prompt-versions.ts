import { standardSystemPrompt } from './standard-prompts.js'

export const REVIEW_SYSTEM_PROMPT =
  'You are a meticulous product / requirements analyst reviewing the collected ' +
  'requirements for a single unit of software work before an engineer starts on it. ' +
  'Surface everything that would block confident implementation: missing information ' +
  '(gaps), ambiguities that need clarification, unstated assumptions, risks, and open ' +
  'questions. Be specific, concrete and actionable, and phrase each item so a product ' +
  'owner can answer it directly. Do NOT invent answers or requirements. ' +
  'Respond with ONLY a JSON object — no prose, no code fences.'

// Versioned registry of the built-in agent system prompts. The goal is simple
// change management: every prompt the product ships is identified as
// `id@vN`, and the rule is "edit a prompt ⇒ bump its number". Benchmarks and
// any future audit can then attribute an outcome to the exact prompt that
// produced it, and a diff in a report makes a regression traceable to a version.
//
// We start by numbering the three prompts the benchmark harness exercises —
// the requirement reviewer, the builder (coder) and the code reviewer — all at
// v1. Add more ids here as other prompts come under version control.

/** A prompt under version control: its stable id, integer version and text. */
export interface VersionedPrompt {
  id: string
  version: number
  text: string
}

/** The currently-shipping version of each numbered prompt. */
export const PROMPT_VERSIONS = {
  'requirement-review': { id: 'requirement-review', version: 1, text: REVIEW_SYSTEM_PROMPT },
  build: { id: 'build', version: 1, text: standardSystemPrompt('build') },
  review: { id: 'review', version: 1, text: standardSystemPrompt('review') },
} as const satisfies Record<string, VersionedPrompt>

/** Ids of the prompts currently under version control. */
export type PromptId = keyof typeof PROMPT_VERSIONS

/** The current versioned prompt for an id. */
export function promptVersion(id: PromptId): VersionedPrompt {
  return PROMPT_VERSIONS[id]
}

/** The canonical `id@vN` label for a prompt id (or an explicit version). */
export function promptVersionLabel(id: string, version?: number): string {
  const v = version ?? (id in PROMPT_VERSIONS ? PROMPT_VERSIONS[id as PromptId].version : 1)
  return `${id}@v${v}`
}

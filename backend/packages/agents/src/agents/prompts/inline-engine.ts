import { ENVIRONMENT_INVESTIGATOR_AGENT_KIND } from '@cat-factory/contracts'
import type { BespokeSystemPrompt } from './bespoke.js'
import { REVIEW_PROMPT, REWORK_PROMPT, WRITER_PROMPT } from './requirements.js'
import { CLARITY_REVIEW_PROMPT, CLARITY_REWORK_PROMPT } from './clarity.js'
import { ENVIRONMENT_INVESTIGATION_PROMPT } from './environment-investigation.js'
import {
  ARCHITECTURE_BRAINSTORM_PROMPT,
  ARCHITECTURE_BRAINSTORM_REWORK_PROMPT,
  REQUIREMENTS_BRAINSTORM_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_PROMPT,
} from './brainstorm.js'

// The system prompts of the INLINE ENGINE steps, keyed by the agent-kind id each runs under.
//
// These kinds have no `registerAgentKind` entry and never dispatch to a container:
// `IterativeReviewService` drives them as plain inline `generateText` calls with the constants
// below. They therefore bypass `systemPromptFor` — which is the seam that both applies a
// workspace prompt override and re-appends the invariants an override may not delete. The map
// closes that gap from the other side: the SERVICE composes its pair (honouring the override on
// the role half), and the prompt EDITOR reads the same pair so the baseline it shows, diffs
// against and restores to is the text that actually runs.
//
// Without it, a workspace editing one of these kinds saw the thin one-line role from `roles.ts`
// as the built-in — a prompt no code path sends — and its saved override was silently ignored at
// run time.
//
// Adding another inline engine kind means adding it here, SPLIT: a kind added with its
// directives inside `role` composes and runs fine, and fails only later, as a workspace that
// edited it loses its JSON output contract or its scope boundary mid-run.

/** The agent-kind ids whose prompts are declared here, in flow order. */
export const REQUIREMENTS_REWORK_AGENT_KIND = 'requirements-rework'
export const REQUIREMENTS_WRITER_AGENT_KIND = 'requirements-writer'
export const CLARITY_REWORK_AGENT_KIND = 'clarity-rework'
export const REQUIREMENTS_BRAINSTORM_REWORK_AGENT_KIND = 'requirements-brainstorm-rework'
export const ARCHITECTURE_BRAINSTORM_REWORK_AGENT_KIND = 'architecture-brainstorm-rework'

export const INLINE_ENGINE_SYSTEM_PROMPTS: Readonly<Record<string, BespokeSystemPrompt>> = {
  'requirements-review': REVIEW_PROMPT,
  [REQUIREMENTS_REWORK_AGENT_KIND]: REWORK_PROMPT,
  [REQUIREMENTS_WRITER_AGENT_KIND]: WRITER_PROMPT,
  'clarity-review': CLARITY_REVIEW_PROMPT,
  [CLARITY_REWORK_AGENT_KIND]: CLARITY_REWORK_PROMPT,
  'requirements-brainstorm': REQUIREMENTS_BRAINSTORM_PROMPT,
  [REQUIREMENTS_BRAINSTORM_REWORK_AGENT_KIND]: REQUIREMENTS_BRAINSTORM_REWORK_PROMPT,
  'architecture-brainstorm': ARCHITECTURE_BRAINSTORM_PROMPT,
  [ARCHITECTURE_BRAINSTORM_REWORK_AGENT_KIND]: ARCHITECTURE_BRAINSTORM_REWORK_PROMPT,
  // Not a pipeline STEP: the deployer's failure path drives it, exactly as it drives the
  // `deploy-fixer`. It belongs here all the same, because what makes a kind a member of this map
  // is that its prompt is sent by a SERVICE rather than composed by `systemPromptFor`, which is
  // the seam that both applies a workspace override and re-appends what an override may not
  // delete.
  [ENVIRONMENT_INVESTIGATOR_AGENT_KIND]: ENVIRONMENT_INVESTIGATION_PROMPT,
}

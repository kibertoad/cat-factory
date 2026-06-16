import type { Env } from '../env'

export interface FragmentLibraryConfig {
  /**
   * Opt-in flag (`PROMPT_LIBRARY_ENABLED=true`). Unlike documents/tasks this
   * needs no encryption key — guideline fragments are not secrets and repo reads
   * reuse the account's existing GitHub installation.
   */
  enabled: boolean
  /**
   * Relevance selection mode: `llm` asks the agent model to pick relevant
   * fragments per run; `deterministic` (default) matches on `appliesTo` + tags.
   */
  selector: 'llm' | 'deterministic'
}

export function loadFragmentLibraryConfig(env: Env): FragmentLibraryConfig {
  return {
    enabled: env.PROMPT_LIBRARY_ENABLED === 'true',
    selector: env.PROMPT_LIBRARY_SELECTOR?.trim() === 'llm' ? 'llm' : 'deterministic',
  }
}

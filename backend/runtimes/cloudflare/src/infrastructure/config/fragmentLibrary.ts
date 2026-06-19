import type { FragmentLibraryConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { FragmentLibraryConfig }

export function loadFragmentLibraryConfig(env: Env): FragmentLibraryConfig {
  return {
    enabled: env.PROMPT_LIBRARY_ENABLED === 'true',
    selector: env.PROMPT_LIBRARY_SELECTOR?.trim() === 'llm' ? 'llm' : 'deterministic',
  }
}

import type { FragmentLibraryConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { FragmentLibraryConfig }

export function loadFragmentLibraryConfig(env: Env): FragmentLibraryConfig {
  return {
    // On by default; opt OUT with `PROMPT_LIBRARY_ENABLED=false`. The library needs
    // no secrets (fragments aren't secrets) and its tables ship in the base
    // migrations, so a stock deployment can curate/link fragments out of the box.
    enabled: env.PROMPT_LIBRARY_ENABLED?.trim() !== 'false',
    selector: env.PROMPT_LIBRARY_SELECTOR?.trim() === 'llm' ? 'llm' : 'deterministic',
  }
}

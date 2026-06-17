import type {
  FragmentSelectionContext,
  FragmentSelector,
  SelectableFragment,
} from '@cat-factory/kernel'
import { selectDeterministic } from './fragment-catalog'

/**
 * The built-in {@link FragmentSelector}: matches on `appliesTo` + tag overlap
 * with no model call. It is the default when the library module is wired without
 * an LLM selector, and the fallback an LLM selector degrades to. See ADR 0006 §5.
 */
export class DeterministicFragmentSelector implements FragmentSelector {
  async select(
    candidates: SelectableFragment[],
    context: FragmentSelectionContext,
  ): Promise<string[]> {
    return selectDeterministic(candidates, context)
  }
}

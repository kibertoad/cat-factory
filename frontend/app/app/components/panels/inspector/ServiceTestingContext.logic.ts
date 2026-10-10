// The pure half of ServiceTestingContext: when a testing context arriving from the board may
// replace what the operator has typed into the textarea. Extracted for the reason every
// `*.logic.ts` here is (a decision worth a test should not need a mounted component to reach),
// and this one is a rule whose failure mode is silent and expensive.

/** The block value moving under the textarea, plus what the textarea currently holds. */
export interface DraftRehydration {
  /** What the operator has in the textarea right now. */
  draft: string
  /** The persisted value the draft was last in step with (the watcher's previous value). */
  previous: string
  /** The persisted value that just arrived. */
  incoming: string
  /** Whether THIS panel has a save in flight. */
  saving: boolean
}

/**
 * The draft to hold after the block's persisted testing context moved.
 *
 * An UNTOUCHED draft follows the board, so a teammate's edit lands live; a touched one is left
 * alone. "Untouched" is measured against the value the draft was last in step with rather than
 * against a dirty flag, because during an edit both are equally "different from what is stored"
 * and only one of them may be overwritten.
 *
 * WHILE THIS PANEL IS SAVING, nothing is taken at all, and that is the case worth the extra state:
 * the board store patches the block OPTIMISTICALLY and restores the old value if the request
 * fails, so a rejected save arrives as a value change whose `previous` is our own optimistic write,
 * which is exactly what an untouched draft looks like. Following it would hand the operator an
 * emptied textarea, an "update failed" toast, and no copy of what they wrote. Every value change
 * inside that window is ours (the optimistic write, the server's echo, the rollback), so ignoring
 * the lot also keeps the keystrokes typed while the request was in flight.
 */
export function rehydratedDraft(state: DraftRehydration): string {
  if (state.saving) return state.draft
  return state.draft === state.previous ? state.incoming : state.draft
}

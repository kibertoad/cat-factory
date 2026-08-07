import { getFragment } from '@cat-factory/prompt-fragments'

// Folds the best-practice fragments selected for a block into the agent's base
// system prompt. There are two sources of fragment bodies, in priority order:
//
//  1. `resolvedFragments` — already-resolved `{ id, body }` entries the execution
//     engine attaches for a `code-aware`/`doc-aware` step: the block's applicable
//     best-practice fragments, resolved against the universal pool. For a TASK that
//     is the task's OWN `fragmentIds` (which already carries the service standards it
//     inherited at creation — the service's set is NOT re-unioned at run time); only a
//     FRAME-level run adds the frame's `serviceFragmentIds`. Used as-is.
//  2. `fragmentIds`: the block's own manual selection, resolved against the SHIPPED
//     catalog in @cat-factory/prompt-fragments. This is the path for non-code-aware kinds
//     (the engine attaches no `resolvedFragments` for them) and for a caller that wired no
//     fragment library at all. It resolves built-ins ONLY: a deployment-registered id lives on
//     the injected registry this layer cannot see, so it folds nothing here. That asymmetry is
//     why the engine-resolved path takes priority on PRESENCE rather than on being non-empty.
//
// Unknown ids (e.g. a fragment removed from the catalog after selection) are
// skipped so a stale selection never breaks a run.

/**
 * How verbose the folded best-practice standards should be:
 *  - `full` (default) — the fragment's full `body`. Reviewer / deep kinds, and any kind not
 *    marked as an implementer, get this.
 *  - `brief` — the fragment's condensed `brief` variant when it defines one (else its full
 *    `body`). Chosen for implementer kinds (coder / fixer / …) that run a long agentic loop
 *    whose system prompt is re-sent on EVERY turn, so a terser standard cuts the per-turn
 *    (and cache-read) context cost without dropping the standard entirely.
 * Resolved per kind by `standardsVerbosityFor` (the `brief-standards` trait) at the dispatch
 * chokepoint and threaded through {@link composeBlockSystemPrompt}.
 */
export type StandardsVerbosity = 'full' | 'brief'

/** One resolved best-practice standard to fold into the prompt: its body + reference label. */
export interface ComposableFragment {
  id: string
  /** The fragment's human title, used as the citation label when present (else the id). */
  title?: string
  body: string
  /**
   * The condensed variant of {@link body}, folded instead of it under `brief` verbosity. Supplied
   * by WHOEVER RESOLVED THE BODY, never re-looked-up here by id: a workspace/account-tier row (or
   * a live document-backed one) may OVERRIDE a built-in id, and re-resolving the brief from the
   * static pool would fold the built-in's condensed text over the tenant's override — silently
   * ignoring their standard for exactly the implementer kinds `brief` targets. A resolver with no
   * brief for the id leaves this absent, which correctly falls back to the full `body`.
   */
  brief?: string
}

/** A block's fragment selection, as the prompt composer needs it. */
export interface ComposableBlock {
  fragmentIds?: string[]
  resolvedFragments?: ComposableFragment[]
}

/**
 * Neutralise the characters that would break the single-line `<best-practice-standard …>` tag —
 * quotes and angle brackets become apostrophes, and any run of whitespace (incl. newlines) collapses
 * to a single space — so an arbitrary fragment title always yields a well-formed attribute value.
 */
function escapeAttr(value: string): string {
  return value.replace(/["<>]/g, "'").replace(/\s+/g, ' ').trim()
}

/**
 * Fold the selected best-practice standards into the base system prompt. Each standard is
 * wrapped in its OWN delimited, labelled block — carrying a stable `id` and its human `title`
 * — rather than concatenated into one blob, so the agent can tell the standards apart and cite
 * a specific one by title (what the code/PR reviewers' adherence report relies on).
 */
function foldStandards(
  baseSystem: string,
  fragments: ComposableFragment[],
  verbosity: StandardsVerbosity = 'full',
): string {
  if (fragments.length === 0) return baseSystem
  const blocks = fragments.map((fragment) => {
    const label = fragment.title?.trim() || fragment.id
    // Implementer kinds fold the condensed `brief` when the RESOLVED fragment carries one;
    // everyone else (and any fragment resolved without a brief) gets the full `body`. See
    // `ComposableFragment.brief` for why this must never re-resolve the brief by id.
    const brief = verbosity === 'brief' ? fragment.brief?.trim() : undefined
    const body = brief || fragment.body.trim()
    return [
      `<best-practice-standard id="${escapeAttr(fragment.id)}" title="${escapeAttr(label)}">`,
      body,
      '</best-practice-standard>',
    ].join('\n')
  })
  return [
    baseSystem,
    '',
    'Follow these standards while doing the work. Each best-practice standard is delimited below',
    'as its own block with a stable id and title — treat each as a SEPARATE standard, and when you',
    'need to cite one refer to it by its title.',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export function composeSystemPrompt(
  baseSystem: string,
  fragmentIds: string[] = [],
  verbosity: StandardsVerbosity = 'full',
): string {
  const fragments = fragmentIds
    .map((id) => getFragment(id))
    .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== undefined)
    .map((fragment) => ({
      id: fragment.id,
      title: fragment.title,
      body: fragment.body,
      // This path resolves the body from the pool, so the pool's brief is the matching one.
      ...(fragment.brief ? { brief: fragment.brief } : {}),
    }))
  return foldStandards(baseSystem, fragments, verbosity)
}

/** How a kind's resolved best-practice standards reach the agent. See {@link composeBlockSystemPrompt}. */
export type StandardsDelivery = 'prompt' | 'context-files' | 'none'

/** The index file a `context-files` kind writes listing every injected standard. */
export const STANDARDS_CONTEXT_INDEX_FILE = 'standards.md'
/** Filename prefix for the per-standard `.cat-context/` files a `context-files` kind writes. */
export const STANDARDS_CONTEXT_FILE_PREFIX = 'standard-'

/**
 * Whether a `context-files` kind's standards were ACTUALLY delivered as injected context files.
 * The fold in {@link composeBlockSystemPrompt} is suppressed for `context-files` delivery, so the
 * standards must have landed some other way (the kind's preOp writing them). When that preOp did
 * not run — e.g. the run-repo resolver is unwired, so the engine skipped ALL of a kind's repo
 * hooks — no files were injected, and folding into the prompt is the correct fallback rather than
 * losing the standards through both channels. Keyed off the shared filename convention so generic
 * prompt composition never has to know a specific kind's constants.
 */
export function standardsDeliveredAsFiles(injectedContextFiles?: { path: string }[]): boolean {
  return !!injectedContextFiles?.some((f) => isStandardsContextFile(f.path))
}

/**
 * Whether an injected context file is one of the STANDARDS files (the index, or a per-standard
 * body), by the shared filename convention. The per-file half of
 * {@link standardsDeliveredAsFiles}, stated once so the two cannot disagree about which files
 * carry standards — an inline caller folds the standards through the system prompt (which honours
 * the kind's {@link StandardsVerbosity}) and must therefore leave exactly these files out of its
 * own prompt fold, or every standard lands twice and at the wrong verbosity.
 */
export function isStandardsContextFile(path: string): boolean {
  return path === STANDARDS_CONTEXT_INDEX_FILE || path.startsWith(STANDARDS_CONTEXT_FILE_PREFIX)
}

/**
 * Compose the system prompt for a block, preferring the engine-resolved tenant
 * catalog bodies when present and otherwise falling back to static id resolution.
 * Both inline and container executors use this so the fragment-library feature
 * applies uniformly to every agent kind, not just the reviewer.
 *
 * `delivery: 'context-files'` returns the base prompt UNCHANGED **once the standards have actually
 * been delivered as files** (`standardsDelivered`): that kind's own preOp writes them as
 * `.cat-context/` files and its prompt points the agent at them, because folding them in would
 * charge a delegating agent for every standard on every turn of its loop. But if that preOp did
 * NOT run (`standardsDelivered === false`), fall back to folding so a `code-aware` kind never ends
 * up with its resolved standards in NEITHER channel. `delivery` is required so no call site can
 * silently fold for a `context-files` kind (the missing-argument bug this guards against).
 *
 * `delivery: 'none'` returns the base prompt unchanged UNCONDITIONALLY: the kind receives no
 * standards through any channel, because it applies none (a kind that scores a change rather
 * than producing one). Unlike `context-files` there is no fallback to fold, since nothing was
 * meant to be delivered in the first place.
 * See {@link AgentKindDefinition.standardsDelivery}.
 */
export function composeBlockSystemPrompt(
  baseSystem: string,
  block: ComposableBlock,
  delivery: StandardsDelivery,
  standardsDelivered = false,
  verbosity: StandardsVerbosity = 'full',
): string {
  if (delivery === 'none') return baseSystem
  if (delivery === 'context-files' && standardsDelivered) return baseSystem
  // PRESENCE, not length. An empty `resolvedFragments` is the engine saying it resolved the
  // selection and the answer was nothing, which is a fact and not a miss: every id was
  // tier-tombstoned, or the deployment's registered pool is empty. Falling back on it would
  // re-resolve those same ids against the SHIPPED catalog and fold the built-ins straight back
  // in, defeating the workspace's own suppression (ADR 0006) and folding a standard the tenant
  // catalog deliberately does not carry. Only an ABSENT field means "nobody resolved this",
  // which is the case the static path exists for.
  if (block.resolvedFragments) {
    return foldStandards(baseSystem, block.resolvedFragments, verbosity)
  }
  return composeSystemPrompt(baseSystem, block.fragmentIds, verbosity)
}

import type { AssistantActionBrief } from '@cat-factory/agents'
import type { DescriptorField, DescriptorFieldValues } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import type { AssistantActionDefinition } from './types.js'

// ---------------------------------------------------------------------------
// The pure half of an assistant turn: reading the model's reply, and matching the names it copied
// out of the sentence against the board.
//
// Both are here rather than in the service for the same reason: they are the parts a turn can be
// WRONG about, and the ones worth exercising without a model or a database. Everything the model
// produces passes through `readAssistantSelection` before it means anything, and every name it
// copied passes through `matchServiceByName` before it addresses a block.
// ---------------------------------------------------------------------------

/** The id a model answers with when no action in the catalog fits. */
export const NO_ACTION = 'none'

/** What the model chose, once the reply has been read. */
export type AssistantSelection =
  | { kind: 'action'; actionId: string; arguments: Record<string, string> }
  | { kind: 'none' }
  /** The reply was not a usable selection at all (empty, not JSON, or the wrong shape). */
  | { kind: 'unreadable' }

/**
 * Read a model reply (already extracted from its fences by kernel's `extractJson`) as a selection.
 *
 * Every value is coerced to a STRING and non-string values are DROPPED rather than stringified: a
 * number or an object where an argument was expected means the model answered a different shape
 * than the one it was given, and `"[object Object]"` reaching a name match would be a lookup for
 * something nobody can type. A dropped argument reads downstream exactly like an omitted one,
 * which is the honest outcome, because the platform then asks about it.
 */
export function readAssistantSelection(value: unknown): AssistantSelection {
  if (value === null || typeof value !== 'object') return { kind: 'unreadable' }
  const record = value as Record<string, unknown>
  const action = record['action']
  if (typeof action !== 'string' || action.trim() === '') return { kind: 'unreadable' }
  const actionId = action.trim()
  if (actionId === NO_ACTION) return { kind: 'none' }
  const raw = record['arguments']
  const args: Record<string, string> = {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed !== '') args[key] = trimmed
    }
  }
  return { kind: 'action', actionId, arguments: args }
}

/**
 * The catalog as the model is shown it, derived from the same declarations the validator reads.
 *
 * `help` is preferred over `label` for the argument line because the label is a form caption ("Repository
 * URL") while the help text is the sentence that says what a value looks like, which is what a router
 * needs. A field with no help falls back to its label rather than rendering an empty description.
 */
export function assistantActionBriefs(
  actions: readonly AssistantActionDefinition[],
): AssistantActionBrief[] {
  return actions.map((action) => ({
    actionId: action.actionId,
    purpose: action.purpose,
    arguments: action.parameters.map((field: DescriptorField) => ({
      key: field.key,
      description: field.help ?? field.label,
      required: field.required === true,
    })),
    examples: action.examples,
  }))
}

/**
 * Drop argument keys the chosen action does not declare.
 *
 * The shared descriptor validator refuses an unknown key, and it is right to: a form that posts one
 * is a bug. A ROUTER that emits one is not the same event (the model was told the key list and put
 * something else beside it), and refusing the whole turn for it throws away an otherwise correct
 * routing over a field nothing would have read. Dropped, the turn proceeds on the declared
 * arguments and any missing required one is asked about, which is where such a reply belongs.
 */
export function keepDeclaredArguments(
  fields: readonly DescriptorField[],
  args: Record<string, string>,
): DescriptorFieldValues {
  const declared = new Set(fields.map((field) => field.key))
  const kept: DescriptorFieldValues = {}
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) kept[key] = value
  }
  return kept
}

/** A service frame a name matched, or why it did not match exactly one. */
export type ServiceMatch =
  | { kind: 'one'; frame: Block }
  | { kind: 'none' }
  | { kind: 'many'; candidates: string[] }

/** Fold a title to the form two people would agree name the same service. */
function foldTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Match a name the model copied out of a sentence against the board's service frames.
 *
 * Three passes, narrowest first, and the ORDER is the rule: an exact title always wins, a
 * punctuation-insensitive match ("user service" ⇄ `user-service`) comes next, and only then a
 * containment match, which is where "the API" finds `Payments API`. Stopping at the first pass
 * that matches anything is what keeps a board holding both `Api` and `Api Gateway` from reporting
 * them as ambiguous when one of them was named outright.
 *
 * A pass that matches SEVERAL is reported as ambiguous with their titles rather than resolved by a
 * tiebreak, because every available tiebreak (shortest, first, most recently created) picks a
 * service on grounds the person never stated. Ambiguity is a question, not a coin toss.
 */
export function matchServiceByName(frames: readonly Block[], name: string): ServiceMatch {
  const wanted = name.trim()
  if (wanted === '') return { kind: 'none' }
  const folded = foldTitle(wanted)
  const passes: ((frame: Block) => boolean)[] = [
    (frame) => frame.title.trim().toLowerCase() === wanted.toLowerCase(),
    (frame) => folded !== '' && foldTitle(frame.title) === folded,
    (frame) =>
      folded !== '' &&
      (foldTitle(frame.title).includes(folded) || folded.includes(foldTitle(frame.title))),
  ]
  for (const matches of passes) {
    const hits = frames.filter(matches)
    if (hits.length === 1) return { kind: 'one', frame: hits[0]! }
    if (hits.length > 1) return { kind: 'many', candidates: hits.map((frame) => frame.title) }
  }
  return { kind: 'none' }
}

/** The service frames of a board: the blocks a connection or a task placement may name. */
export function serviceFramesOf(blocks: readonly Block[]): Block[] {
  return blocks.filter(
    (block) =>
      block.level === 'frame' && block.type === 'service' && !block.internal && !block.archived,
  )
}

/**
 * The repository an issue's external id names, or null when the id does not name one.
 *
 * Every REPO-BACKED task source shapes its canonical id as `<project path>#<number>` (GitHub's
 * `acme/payments#12`, GitLab's `group/subgroup/billing#5`), so the project path is everything
 * before the last `#`, its last segment is the repository and the rest is the owner (a GitLab
 * namespace legitimately has several segments; a GitHub owner has one).
 *
 * Null for an id with no path at all, which is exactly what a Jira or Linear key (`PROJ-12`) is.
 * That is not a failure to parse: those trackers have no repository, so there is nothing here to
 * infer a service from and the turn asks which service to file under. A deployment-registered
 * source that shapes its ids differently lands in the same place, which is the safe direction:
 * a question, never a task filed against a repository nobody named.
 */
export function issueRepoSlug(externalId: string): { owner: string; repo: string } | null {
  const hash = externalId.lastIndexOf('#')
  const path = (hash === -1 ? externalId : externalId.slice(0, hash)).trim()
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length < 2) return null
  return { owner: segments.slice(0, -1).join('/'), repo: segments[segments.length - 1]! }
}

import type { AssistantActionBrief } from '@cat-factory/agents'
import type { DescriptorField, DescriptorFieldValues } from '@cat-factory/contracts'
import { isSafeRepoDirPath, parseRepoWebUrl } from '@cat-factory/contracts'
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

/** A repository a request named, plus the subtree the reference itself pointed into. */
export interface AssistantRepoRef {
  owner: string
  repo: string
  /**
   * The repo-root-relative subdirectory the reference named, when it named one.
   *
   * Only a URL that points INTO the tree (`/tree/<ref>/packages/api`) carries this, and it is
   * already checked against the shared path rule here, because a value recovered from a link has
   * been through no validator on the way in.
   */
  directory?: string
}

/**
 * The repository a person named: a pasted web URL, or the bare `owner/repo` slug.
 *
 * The URL is the primary form and is parsed by the SHARED parser, the same one the repository
 * picker resolves a paste with, so GitHub and GitLab shapes (subgroups, `/-/`, `/tree/<ref>/…`)
 * and self-managed hosts are understood identically on both surfaces.
 *
 * The SLUG is accepted here and deliberately NOT in that shared parser, which declines it on
 * purpose (a slug has no host, so the picker cannot tell one from a search term). This surface
 * has the opposite problem: when a URL names a repository the workspace does not project, the
 * turn answers with the projected repositories of the same NAME under other owners, and those
 * near-misses are slugs. Offering `acme/payments` as the answer to "which repository did you
 * mean?" and then refusing it as unreadable would be a question with no acceptable answer.
 */
export function parseRepoRef(input: string): AssistantRepoRef | null {
  const url = parseRepoWebUrl(input)
  if (url) {
    const directory = url.kind === 'dir' && url.path !== '' ? url.path : undefined
    return {
      owner: url.owner,
      repo: url.repo,
      ...(directory !== undefined && isSafeRepoDirPath(directory) ? { directory } : {}),
    }
  }
  return parseRepoSlug(input)
}

/** One `owner/repo` path segment, matching the shared URL parser's own segment grammar. */
const SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * A bare `owner/repo` (or GitLab's `group/subgroup/project`) slug, or null.
 *
 * Strict on purpose: it runs only after the URL parse has declined, so anything it accepts is
 * something a person typed INSTEAD of a link, and a loose rule here would read a sentence
 * fragment as a repository name.
 */
function parseRepoSlug(input: string): AssistantRepoRef | null {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || /\s/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.length < 2 || !segments.every((segment) => SLUG_SEGMENT.test(segment))) return null
  const repo = segments[segments.length - 1]!.replace(/\.git$/i, '')
  if (repo === '') return null
  return { owner: segments.slice(0, -1).join('/'), repo }
}

/** A service frame a name matched, or why it did not match exactly one. */
export type ServiceMatch =
  | { kind: 'one'; frame: Block }
  | { kind: 'none' }
  | { kind: 'many'; candidates: string[] }

/**
 * Fold a title to the form two people would agree name the same service.
 *
 * Lossy by construction, and one of its losses is TOTAL: a title written in a non-Latin script,
 * in emoji, or in punctuation alone folds to the empty string, because the fold keeps only ASCII
 * alphanumerics. That is a legitimate title (`決済サービス` names a service someone runs), so the
 * empty fold is a value the matcher has to REFUSE to reason about rather than a case that cannot
 * arise: `''` is a substring of every string, so a frame that folds to nothing would otherwise
 * match every name anybody types.
 */
function foldTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** A frame with its title folded ONCE, rather than re-folded by each pass that looks at it. */
interface FoldedFrame {
  frame: Block
  folded: string
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
 *
 * BOTH sides of the two folded passes are checked for an empty fold, and each of the two is a
 * separate bug the guard closes. An empty fold on the QUERY side would match everything; an empty
 * fold on the FRAME side would make that one frame match everything, which is worse, because it
 * turns every other name on the board into a false `ambiguous_service` and the frame itself is
 * still unreachable except by its exact title. A title with nothing to fold is matched by pass 1
 * alone, which compares the real characters and needs no fold at all.
 */
export function matchServiceByName(frames: readonly Block[], name: string): ServiceMatch {
  const wanted = name.trim()
  if (wanted === '') return { kind: 'none' }
  const lowered = wanted.toLowerCase()
  const folded = foldTitle(wanted)
  const candidates: FoldedFrame[] = frames.map((frame) => ({
    frame,
    folded: foldTitle(frame.title),
  }))
  const passes: ((candidate: FoldedFrame) => boolean)[] = [
    ({ frame }) => frame.title.trim().toLowerCase() === lowered,
    (candidate) => folded !== '' && candidate.folded === folded,
    (candidate) =>
      folded !== '' &&
      candidate.folded !== '' &&
      (candidate.folded.includes(folded) || folded.includes(candidate.folded)),
  ]
  for (const matches of passes) {
    const hits = candidates.filter(matches)
    if (hits.length === 1) return { kind: 'one', frame: hits[0]!.frame }
    if (hits.length > 1) {
      return { kind: 'many', candidates: hits.map(({ frame }) => frame.title) }
    }
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

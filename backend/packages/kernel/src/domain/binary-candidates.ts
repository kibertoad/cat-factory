import type {
  BinaryCandidate,
  BinaryCandidateComparison,
  BinaryCandidateStepState,
} from '@cat-factory/contracts'
import type { BinaryGeneratorView } from './binary-generator-registry.js'
import { extractFencedDeclaration } from './fenced-declaration.js'

// ---------------------------------------------------------------------------
// Pure logic for the CANDIDATE-COMPARISON half of a binary-output step
// (docs/initiatives/binary-output-foundational-storage.md): the phase-A brief that asks an agent
// for comparable candidates, the read-back of what it staged, and the phase-B brief that tells it
// which candidates a human kept and under which ids.
//
// A sibling of `binary-generators.ts` rather than more of it, because the two answer different
// questions at different moments: that module is about WHICH integrations a step may call, this
// one is about a step calling SEVERAL of them on purpose and handing the choice to a person. No
// I/O, so admission, the dispatch brief and the settlement read-back all apply identical rules.
// ---------------------------------------------------------------------------

/** The fenced block a comparison step's FIRST phase ends its reply with. */
export const BINARY_CANDIDATE_DECLARATION_TAG = 'binary-candidates'

/**
 * How many candidates ride ONE step's comparison.
 *
 * A hard bound on a surface a human has to look at, not merely on a row size: forty images side
 * by side is not a comparison, and a step that generated that many has misread its own brief.
 * Everything past it is COUNTED (`omitted`) rather than silently dropped, so the surface can say
 * the list is a prefix.
 */
export const MAX_BINARY_CANDIDATES = 24

/** Longest `service`/`location` accepted per candidate; beyond it the entry is INVALID. */
const MAX_IDENTITY_CHARS = 512

/** Longest optional display field retained per candidate; the excess is elided with a marker. */
const MAX_DISPLAY_CHARS = 300

/**
 * What a first-phase reply declared it staged, before the engine mints ids and records it.
 *
 * Every loss is bookkept exactly as `parseBinaryOutputDeclaration` does it, and the two extra
 * fields are the ones this surface needs and that one does not: an unusable preview is a
 * candidate that renders as metadata rather than a candidate that failed, and `undeclared` /
 * `parseFailed` are what turn a comparison into a stated `no_choice` rather than a wedged run.
 */
export interface BinaryCandidateDeclaration {
  candidates: Omit<BinaryCandidate, 'id'>[]
  invalidEntries: number
  omitted: number
  unusablePreviews: number
  parseFailed: boolean
  undeclared: boolean
}

/**
 * Read the candidates a comparison step staged out of its reply.
 *
 * The contract is a fenced ```binary-candidates block holding a JSON array of
 * `{ generator?, subject?, service, location, contentType?, previewUrl?, label?, note? }`. The
 * LAST block wins, like every other declaration in this feature, because the guidance asks the
 * agent to END its reply with it and models illustrate the shape first.
 *
 * Ids are NOT read from the reply and are minted by the caller instead. The id is what a human's
 * choice names and what the second phase resolves against, so a model that repeats one, omits
 * one, or writes a paragraph into one would break the decision rather than its own bookkeeping.
 * The agent's own name for a candidate is kept as `label`, so its prose can still be lined up
 * with the rows.
 */
export function parseBinaryCandidateDeclaration(
  output: string | undefined,
): BinaryCandidateDeclaration {
  const empty: BinaryCandidateDeclaration = {
    candidates: [],
    invalidEntries: 0,
    omitted: 0,
    unusablePreviews: 0,
    parseFailed: false,
    undeclared: false,
  }
  const body = extractFencedDeclaration(output, BINARY_CANDIDATE_DECLARATION_TAG)
  if (body === null) return { ...empty, undeclared: true }
  // `none` is accepted and means the same thing an empty array does: the agent staged nothing.
  // It is a legitimate answer (every generation failed, or the scope turned out to be empty) and
  // it resolves to `too_few` rather than to an error, so the run advances and the step's report
  // says what happened.
  if (body.toLowerCase() === 'none') return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // silent-catch-ok: an unparseable body is a REPORTED state (`parseFailed` → a `no_choice`
    // the surface names) rather than an error: the generation itself already happened.
    return { ...empty, parseFailed: true }
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]

  const candidates: Omit<BinaryCandidate, 'id'>[] = []
  let invalidEntries = 0
  let omitted = 0
  let unusablePreviews = 0
  for (const entry of entries) {
    const coerced = coerceCandidate(entry)
    if (!coerced) {
      invalidEntries++
      continue
    }
    if (candidates.length >= MAX_BINARY_CANDIDATES) {
      omitted++
      continue
    }
    if (coerced.previewRefused) unusablePreviews++
    candidates.push(coerced.candidate)
  }
  return {
    candidates,
    invalidEntries,
    omitted,
    unusablePreviews,
    parseFailed: false,
    undeclared: false,
  }
}

function coerceCandidate(
  entry: unknown,
): { candidate: Omit<BinaryCandidate, 'id'>; previewRefused: boolean } | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const service = identityField(record.service)?.toLowerCase()
  const location = identityField(record.location)
  if (!service || !location) return null
  const candidate: Omit<BinaryCandidate, 'id'> = { service, location }
  // Lowercased like `service` and for the same reason: registry ids are lower-kebab slugs, so a
  // model that capitalises one means the registered integration.
  const generator = identityField(record.generator)?.toLowerCase()
  const label = displayField(record.label)
  const subject = displayField(record.subject)
  const contentType = displayField(record.contentType)
  const note = displayField(record.note)
  if (generator) candidate.generator = generator
  if (label) candidate.label = label
  if (subject) candidate.subject = subject
  if (contentType) candidate.contentType = contentType
  if (note) candidate.note = note
  const rawPreview = typeof record.previewUrl === 'string' ? record.previewUrl.trim() : ''
  const previewUrl = rawPreview && isRenderablePreviewUrl(rawPreview) ? rawPreview : undefined
  if (previewUrl) candidate.previewUrl = previewUrl
  return { candidate, previewRefused: rawPreview !== '' && previewUrl === undefined }
}

/**
 * Whether a declared preview URL may be put in an `<img src>` on the board.
 *
 * `https` and nothing else. This string is written by a MODEL and rendered in a human's browser,
 * which is the one place in this feature where a declaration is not merely recorded, so the rule
 * is a whitelist rather than a blacklist: `javascript:` and `data:` are the obvious refusals, but
 * so is plain `http` (a mixed-content image silently fails to load, which reads as a broken
 * candidate rather than a refused link) and so is loopback (the browser's own machine is not the
 * container's, so such a link points at whatever happens to be listening on the reader's laptop).
 *
 * Deliberately NOT `isAllowedMcpHttpUrl`, whose own note says it is not a guard for untrusted
 * input: that predicate judges deployment-authored composition-root data and allows cleartext
 * loopback precisely because the caller is a sidecar-hosting container. Both facts are wrong here,
 * and reusing it because the shapes match is how a rule's rationale gets left behind.
 *
 * A refused URL costs the candidate its picture, never its row: the location, the generator and
 * the note are what the comparison is anchored on, and dropping the whole entry over a bad link
 * would remove a real generation from a decision.
 */
export function isRenderablePreviewUrl(raw: string): boolean {
  // The WHATWG parser, reached through `globalThis` because kernel compiles against the ES2022
  // lib alone: the same trade `agent-capabilities.ts` makes, and made here for the stronger of
  // its two reasons: the string is rendered by a BROWSER, so the only parser whose verdict is
  // binding is the one the browser uses. A runtime without it REFUSES rather than falling back to
  // a regex, since a hand-written scheme scan is exactly how `javascript:` survives an escape.
  const parser = (globalThis as { URL?: new (url: string) => { readonly protocol: string } }).URL
  if (!parser) return false
  try {
    return new parser(raw).protocol === 'https:'
  } catch {
    // silent-catch-ok: an unparseable URL is simply not renderable, and the caller COUNTS the
    // refusal (`unusablePreviews`) rather than dropping it silently.
    return false
  }
}

/** A field that IDENTIFIES something: non-empty and within the cap, or the entry is invalid. */
function identityField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_IDENTITY_CHARS) return null
  return trimmed
}

/** A field that DESCRIBES something: kept best-effort, elided past the cap with a marker. */
function displayField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_DISPLAY_CHARS ? `${trimmed.slice(0, MAX_DISPLAY_CHARS)}…` : trimmed
}

// --- agent-facing rendering -------------------------------------------------

/**
 * The FIRST-PHASE brief section: generate candidates, stage them, declare them, store nothing as
 * final.
 *
 * The whole section exists because the default behaviour of a competent agent is the wrong one
 * here. Handed two image APIs and a subject, it picks one, generates once, stores the result and
 * reports success, which is exactly the unobserved choice this feature exists to surface. So the
 * instruction is explicit on all four counts: generate from EVERY integration, do not treat any
 * of it as a deliverable, put them somewhere a person can look at them, and stop.
 *
 * How to get several candidates from ONE integration is the one place the capability vocabulary
 * changes the instruction rather than a control: an integration declaring `candidate-batch`
 * returns them from a single call, and one that does not has to be called again with a different
 * seed. Getting that backwards either multiplies the bill or sends a parameter the endpoint
 * rejects, and no description could have said which.
 */
export function renderBinaryCandidateSection(input: {
  comparison: BinaryCandidateComparison
  selected: readonly BinaryGeneratorView[]
  /** Whether the step also fixes a seed, which changes what "vary the seed" can mean. */
  fixedSeed?: number
}): string[] {
  const perGenerator = input.comparison.perGenerator ?? 1
  const batched = input.selected.filter((g) => g.capabilities.includes('candidate-batch'))
  const lines: string[] = [
    '## Candidates for review',
    '',
    'This step does NOT deliver its artifacts directly. A person compares candidates and decides which survive, so your job in this pass is to produce the choices and stop.',
    '',
  ]
  if (input.selected.length > 1) {
    lines.push(
      `- Generate ${perGenerator === 1 ? 'one candidate' : `${perGenerator} candidates`} per subject from EVERY integration listed above, not from whichever one you would have picked. The comparison is between them; a subject missing an integration's candidate cannot be judged.`,
    )
  } else {
    lines.push(
      `- Generate ${perGenerator} candidate${perGenerator === 1 ? '' : 's'} per subject. Make them meaningfully different from each other, and say how in each candidate's \`note\`.`,
    )
  }
  if (perGenerator > 1) {
    lines.push(
      batched.length > 0
        ? `- ${joinIds(batched.map((g) => g.id))} can return several candidates from ONE call: ask for ${perGenerator} that way rather than repeating the request. For any other integration, repeat the call with a different seed.`
        : '- No selected integration returns several candidates from one call, so repeat the request with a different seed for each candidate rather than looking for a count parameter.',
    )
  }
  if (input.fixedSeed !== undefined && perGenerator > 1) {
    lines.push(
      `- This step fixes a seed (${input.fixedSeed}). Use it for the FIRST candidate of each subject and vary it for the rest, so one candidate stays reproducible and the others are genuinely different.`,
    )
  }
  lines.push(
    '- Stage every candidate through the storage service below, clearly marked as a candidate rather than a deliverable. Do NOT store anything at its final location, delete anything, or overwrite an existing asset in this pass.',
    `- End your reply with a fenced \`\`\`${BINARY_CANDIDATE_DECLARATION_TAG} block: a JSON array of \`{ generator, subject, service, location, contentType, previewUrl, label, note }\`. \`generator\` and \`subject\` are what the comparison is grouped and labelled by, so omitting them makes the candidates unreadable to whoever decides.`,
    "- `previewUrl` must be an https URL the storage service issued for the candidate. If it issues none, leave it out rather than constructing one: the reviewer is shown the candidate's details instead, which is honest, and a broken image is not.",
    '- Then STOP. Do not declare `binary-outputs` in this pass; you will be run again with the decision.',
    '',
  )
  return lines
}

/**
 * The SECOND-PHASE brief section: what the human kept, under which ids, and what to do with the
 * rest.
 *
 * The decision is DATA and this is where it becomes work. The platform recorded which candidates
 * survive; the agent is the party that can move a file, so it is told to promote exactly those
 * and nothing else. Two instructions carry the weight:
 *
 * - **Every kept candidate is named with its own id when there is more than one.** Two survivors
 *   stored at one address is one artifact, and the ALTERNATE ID is the entire mechanism by which
 *   keeping two is a real outcome.
 * - **The discarded candidates are named, and clearing them up is asked for explicitly.** The
 *   staged files exist; a pass that promotes one and forgets the other three leaves an asset
 *   store with four sprites in it, of which one is the sprite.
 */
export function renderBinaryCandidateChoiceSection(state: BinaryCandidateStepState): string[] {
  const choice = state.choice
  if (!choice) return []
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]))
  const lines: string[] = [
    '## The candidate decision',
    '',
    'You generated candidates in an earlier pass and a person has now chosen. Deliver exactly what was kept.',
    '',
  ]
  for (const kept of choice.kept) {
    const candidate = byId.get(kept.candidateId)
    if (!candidate) continue
    const identity = [
      candidate.generator ? `from \`${candidate.generator}\`` : 'from an unattributed generator',
      candidate.subject ? `for ${candidate.subject}` : null,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(
      `- KEEP the candidate staged at \`${candidate.location}\` in \`${candidate.service}\` (${identity}).` +
        (kept.storeAs
          ? ` Store it as \`${kept.storeAs}\`: that id is what distinguishes it from the other kept candidates, so use it exactly.`
          : " Store it under this step's ordinary naming."),
    )
  }
  const discarded = choice.discarded.flatMap((id) => byId.get(id) ?? [])
  if (discarded.length > 0) {
    lines.push(
      `- DISCARD the ${discarded.length} candidate${discarded.length === 1 ? '' : 's'} the person did not keep, and remove the staged file${discarded.length === 1 ? '' : 's'} where the storage service allows it: ${discarded.map((c) => `\`${c.location}\``).join(', ')}. If it does not, say so in your report rather than leaving it unsaid.`,
    )
  }
  if (choice.note) {
    lines.push(
      '',
      `The person who chose added: ${choice.note}`,
      'Apply it to what you store. If it asks for a change the kept candidate does not already have, regenerate that artifact with the change rather than storing the candidate as-is.',
    )
  }
  lines.push(
    '',
    'Do NOT generate a new set of candidates and do NOT declare `binary-candidates` again. Store what was kept and declare it in the `binary-outputs` block as usual.',
    '',
  )
  return lines
}

/** `` `a` and `b` ``; `` `a`, `b` and `c` ``. Total for any length, including the empty list. */
function joinIds(ids: readonly string[]): string {
  const quoted = ids.map((id) => `\`${id}\``)
  return [quoted.slice(0, -1).join(', '), ...quoted.slice(-1)].filter(Boolean).join(' and ')
}

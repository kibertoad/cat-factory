import type {
  AgentRunContext,
  DocumentFreshness,
  DocumentOrigin,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceKind,
  LinkedDocumentRefresher,
  Logger,
  TaskRecord,
  TaskRepository,
} from '@cat-factory/kernel'
import {
  assertContextDocumentsReadable,
  buildExcerpt,
  CONTEXT_BUDGET,
  hasReadableContent,
  redactSecrets,
} from '@cat-factory/kernel'
import { orderSourcesByClaimConfidence } from '@cat-factory/contracts'
import { extractReferences } from '@cat-factory/integrations'

/**
 * Resolve a URL named in prose to the document it refers to, by its stable
 * `(source, externalId)` key. Built from the document providers' `parseRef` so a noisy
 * pasted link (title segment, `&t=` tracking params, dash vs colon node id) still maps to
 * the canonical id the document was imported under. Returns null when no provider claims
 * the URL.
 */
export type DocumentUrlResolver = (
  url: string,
) => { source: DocumentSourceKind; externalId: string } | null

// The block's "linked context" — the requirements / RFCs / PRDs / tracker issues a human
// attached to it, plus anything its description names outright — resolved into the shape agent
// prompts render (`linkedContextSection`) and the container materialises under `.cat-context/`.
//
// This lives on its own rather than inside `AgentContextBuilder` because it has TWO callers with
// nothing else in common: the builder (every dispatch that goes through the engine) and the
// initiative-planning INTERVIEWER, an inline service that assembles its own prompt and never
// passes through the builder at all. Sharing the implementation is what keeps the interviewer
// from seeing a different set of attachments than the analyst and planner that follow it.

/** What the resolver needs; every source is optional, so an unwired deployment resolves nothing. */
export interface LinkedContextSources {
  documents?: DocumentRepository
  tasks?: TaskRepository
  /** Canonicalise a pasted URL to a `(source, externalId)` so link variants still resolve. */
  documentUrlResolver?: DocumentUrlResolver
  /**
   * Re-confirm each resolved document against its source before the run reads it, so an agent gets
   * the CURRENT revision of a linked page rather than the copy import happened to store. Absent ⇒ no
   * refresh and no freshness verdict, which is byte-for-byte the prior behaviour.
   */
  refresher?: LinkedDocumentRefresher
  /**
   * Reports the references that a document provider CLAIMED but that matched nothing imported —
   * the one class of unresolved reference that must NOT fail the run (see
   * {@link reportUnmatchedUrls}). Absent ⇒ they are dropped as before.
   */
  logger?: Logger
}

/**
 * Build the URL→document canonicaliser from the configured document providers, so a Figma/Notion
 * link pasted into prose auto-matches its imported page even when it carries a title segment or
 * tracking params the stored canonical url omits. No providers ⇒ undefined (url-string match only).
 *
 * TWO PASSES, host-PINNED providers first, through the shared `orderSourcesByClaimConfidence` (the
 * refusal path that names a claimant reads the same function, so the confidence rule has one home).
 * The providers' `parseRef` implementations differ in what a claim over a URL is worth: a pinned one
 * (Figma, Zeplin, GitHub, Linear) refuses anything off its own host, so a claim is near-proof, while
 * a blind one claims a SHAPE — `parseNotionRef` takes any UUID-shaped run anywhere in the string,
 * `parseConfluenceRef` any `/pages/<digits>` segment. First claimer used to win in registration
 * order, so a deployment that registered Notion ahead of Figma had Notion silently claim a Figma URL
 * whose file key happened to carry a UUID-shaped run, and the point lookup then resolved against the
 * wrong source's key space and found nothing: a linked design that reached the agent as no context at
 * all, with only the "nothing is imported" info line to say so. Ordering by confidence rather than by
 * registration is what makes a pinned claim unstealable; within each pass, registration order still
 * decides (two pinned sources cannot claim one host).
 */
export function makeDocumentUrlResolver(
  providers: readonly { kind: DocumentSourceKind; parseRef: (url: string) => string | null }[] = [],
): DocumentUrlResolver | undefined {
  if (!providers.length) return undefined
  const ordered = orderSourcesByClaimConfidence(providers)
  return (url: string) => {
    for (const provider of ordered) {
      const externalId = provider.parseRef(url)
      if (externalId) return { source: provider.kind, externalId }
    }
    return null
  }
}

/**
 * Assemble the resolver's sources from the container's dependency bag, so the engine's dispatch
 * path and the inline initiative interviewer read the same corpus through the same canonicaliser
 * rather than each hand-rolling the assembly.
 */
export function linkedContextSourcesFrom(deps: {
  documentRepository?: DocumentRepository
  taskRepository?: TaskRepository
  documentSourceProviders?: readonly {
    kind: DocumentSourceKind
    parseRef: (url: string) => string | null
  }[]
  documentRefresher?: LinkedDocumentRefresher
  logger?: Logger
}): LinkedContextSources {
  const documentUrlResolver = makeDocumentUrlResolver(deps.documentSourceProviders)
  return {
    ...(deps.documentRepository ? { documents: deps.documentRepository } : {}),
    ...(deps.taskRepository ? { tasks: deps.taskRepository } : {}),
    ...(documentUrlResolver ? { documentUrlResolver } : {}),
    ...(deps.documentRefresher ? { refresher: deps.documentRefresher } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  }
}

/**
 * One resolved document: the shape `AgentRunContext.block.contextDocs` carries, plus the source
 * identity that shape has no reason to hold.
 *
 * The agent reads a page, not an id, so `externalId` is stripped before the context crosses to
 * the container. It is carried this far because the caller that RECORDS what a dispatch read
 * needs a stable key, and the two visible fields cannot be one: an `upload` has no URL, so a key
 * falling back to the title merges two same-titled uploads. It is the same `(origin, externalId)`
 * pair this resolver already dedupes its own corpus by.
 */
type LinkedContextDoc = NonNullable<AgentRunContext['block']['contextDocs']>[number] & {
  externalId: string
}

/** The resolved context, in the shape `AgentRunContext.block` carries it (see the doc type). */
export interface LinkedContext {
  docs: LinkedContextDoc[]
  tasks: NonNullable<AgentRunContext['block']['contextTasks']>
}

/** What a caller of {@link resolveLinkedContext} steers, beyond the block it is resolving for. */
export interface LinkedContextOptions {
  /** Skip the block's ATTACHMENTS (reworked mode folds them into the incorporated doc already). */
  includeLinked: boolean
  /**
   * The corpus's document ORIGINS, reported the moment they are known and BEFORE the dispatch-time
   * refresh (a live probe per source, and a whole-file download for anything that moved). It exists
   * because a caller that only needs to know WHAT KIND of documents a run carries (the
   * design-context fragment fold) would otherwise wait on network work whose answer cannot change
   * the origins, turning two parallel resolutions into one serial chain.
   */
  onDocumentsResolved?: (origins: readonly DocumentOrigin[]) => void
}

/**
 * Resolve the high-confidence external context for a block: the docs/tasks a human attached to it
 * (only when `includeLinked` — skipped in reworked mode, where the incorporated requirements doc
 * already folds them in) UNIONed with any items the `description` names explicitly (a Jira key, a
 * fully-qualified GitHub `owner/repo#N`, or a URL), each resolved against the imported corpus by a
 * POINT LOOKUP (no full-corpus scan — a single keyed/URL query per named reference). Each source
 * repo is optional, so this is a no-op for sources that aren't wired. Deduped by
 * (source, externalId). The full body travels to the container as a materialised file; the prompt
 * carries only the one-line `summary` (see the executor + `linkedContextSection`).
 *
 * THROWS (`assertContextDocumentsReadable`) when a resolved document has no readable content: a
 * reference the platform cannot put in front of the agent breaks the run rather than being dropped
 * in silence. A URL that no imported item matches at all is the one case that stays best-effort,
 * and it is logged rather than dropped — see {@link reportUnmatchedUrls} for why it cannot be a
 * refusal.
 */
export async function resolveLinkedContext(
  sources: LinkedContextSources,
  workspaceId: string,
  blockId: string,
  description: string,
  opts: LinkedContextOptions,
): Promise<LinkedContext> {
  const docs = new Map<string, DocumentRecord>()
  const tasks = new Map<string, TaskRecord>()
  const docKey = (d: DocumentRecord) => `${d.source}:${d.externalId}`
  const taskKey = (t: TaskRecord) => `${t.source}:${t.externalId}`
  const addDoc = (d: DocumentRecord | null) => {
    if (d && !docs.has(docKey(d))) docs.set(docKey(d), d)
  }
  const addTask = (t: TaskRecord | null) => {
    if (t && !tasks.has(taskKey(t))) tasks.set(taskKey(t), t)
  }

  if (opts.includeLinked) {
    const [linkedDocs, linkedTasks] = await Promise.all([
      sources.documents?.listByBlock(workspaceId, blockId) ?? [],
      sources.tasks?.listByBlock(workspaceId, blockId) ?? [],
    ])
    for (const d of linkedDocs) addDoc(d)
    for (const t of linkedTasks) addTask(t)
  }

  // Resolve explicitly-named references against the imported corpus — never a full-corpus
  // scan. Only items that actually exist are added (a `UTF-8` that happens to match the
  // Jira-key shape just resolves to nothing); nothing is fetched live. The keyed jira/github
  // refs are BATCH-resolved in one chunked-`IN` read per source (`listByRefs`, never a
  // point-read per reference — an N+1); the URL lookups stay per-URL point reads. Both run
  // concurrently, and results are folded in in reference order so the dedupe (and the
  // resulting context ordering) stays deterministic.
  const refs = extractReferences(description ?? '')
  const documents = sources.documents
  const taskRepo = sources.tasks
  const [keyedTasks, urlItems] = await Promise.all([
    taskRepo?.listByRefs(workspaceId, refs.taskRefs) ?? [],
    Promise.all(
      refs.urls.map(async (url) => {
        const claimedBy = documents ? (sources.documentUrlResolver?.(url)?.source ?? null) : null
        const [doc, task] = await Promise.all([
          (async () => {
            if (!documents) return null
            // Prefer a precise match by the document's stable (source, externalId) — a pasted
            // link canonicalised through the providers' parseRef — so a Figma/Notion URL with a
            // title segment or tracking params still resolves. Fall back to the url-string
            // lookup for any source the resolver doesn't claim (or when it isn't wired).
            const ref = sources.documentUrlResolver?.(url)
            const byRef = ref ? await documents.get(workspaceId, ref.source, ref.externalId) : null
            return byRef ?? (await documents.getByUrl(workspaceId, url))
          })(),
          taskRepo?.getByUrl(workspaceId, url) ?? null,
        ])
        return { url, claimedBy, doc, task }
      }),
    ),
  ])
  // Fold the batch result in in reference order (listByRefs makes no ordering guarantee),
  // so the dedupe and context ordering match the by-reference sequence deterministically.
  const keyedByRef = new Map(keyedTasks.map((t) => [taskKey(t), t] as const))
  for (const ref of refs.taskRefs)
    addTask(keyedByRef.get(`${ref.source}:${ref.externalId}`) ?? null)
  for (const { doc, task } of urlItems) {
    addDoc(doc)
    addTask(task)
  }
  reportUnmatchedUrls(sources.logger, blockId, urlItems)

  const resolvedDocs = [...docs.values()]
  // The corpus is settled here; everything below is about its CURRENCY, not its membership. Report
  // the origins now so a caller that only needs the kinds is not held behind a live source probe.
  opts.onDocumentsResolved?.(resolvedDocs.map((record) => record.source))

  // Re-confirm every resolved document against its source BEFORE anything else looks at it, so both
  // the readability refusal below and the body the agent reads are about the CURRENT revision rather
  // than the copy import stored. Best-effort by the refresher's own contract, so this cannot fail the
  // run; with no refresher wired every document comes back unchanged and un-annotated.
  const refreshed = await refreshDocuments(sources.refresher, workspaceId, resolvedDocs)

  // BREAK, never skip: a reference that resolved to a page with nothing in it would otherwise put
  // the agent in front of a `.cat-context/` file holding a title and a URL it cannot open, with
  // the run reading as perfectly healthy. Asserted HERE rather than at each caller so no dispatch
  // path can opt out — the engine's builder and the inline initiative interviewer both go through
  // this resolver, which is the whole reason it exists as a shared function.
  //
  // Asserted on the REFRESHED records, because a page emptied since import is exactly the case worth
  // refusing: asserting on the stored copy would admit a run whose agent then reads a blank file.
  assertContextDocumentsReadable(
    refreshed
      .filter(({ record }) => !hasReadableContent(record))
      .map(({ record }) => ({ title: record.title, url: record.url })),
  )

  return {
    docs: refreshed.map(({ record, freshness }) => toContextDoc(record, freshness)),
    tasks: [...tasks.values()].map((t) => toContextTask(t)),
  }
}

/**
 * Run the dispatch-time refresh, or pass every document through untouched when none is wired.
 *
 * The un-wired shape returns `freshness: undefined` rather than a synthesised verdict: a deployment
 * with no refresher did not conclude that these bodies are unverifiable, it never asked, and the
 * materialised header must stay byte-for-byte what it was rather than gaining a warning about a check
 * this deployment does not run.
 */
async function refreshDocuments(
  refresher: LinkedDocumentRefresher | undefined,
  workspaceId: string,
  records: readonly DocumentRecord[],
): Promise<readonly { record: DocumentRecord; freshness?: DocumentFreshness }[]> {
  if (!refresher || !records.length) return records.map((record) => ({ record }))
  return refresher.refresh(workspaceId, records)
}

/**
 * Report the URLs a document provider CLAIMED (its `parseRef` resolved an id out of them) but that
 * matched neither an imported document nor an imported issue.
 *
 * These are deliberately NOT a refusal, and that asymmetry is the point: the providers' `parseRef`
 * implementations are host-BLIND — `parseNotionRef` claims any string carrying a UUID-shaped run,
 * `parseConfluenceRef` any URL with a `/pages/<digits>` segment — so a claim is evidence of a
 * SHAPE, not of a reference. Failing runs on it would block a task whose description happens to
 * link a dashboard or a blog post. So the drop stays, and the log is what keeps it from being
 * silent: an operator can see that a link the description named reached no imported page (the
 * remedy being to import it, which turns it into real context).
 *
 * It logs at INFO, not `warn`, for the same reason it does not refuse. The condition is a NORMAL
 * and PERMANENT state of a healthy task — a description that links a dashboard has nothing wrong
 * with it — and this runs on every dispatch of every step, so a `warn` would repeat forever with
 * no remedy anyone intends to apply, which is how a channel gets tuned out. `info` is the default
 * threshold, so the line is still there for whoever asks "why didn't the agent see my page".
 */
function reportUnmatchedUrls(
  logger: Logger | undefined,
  blockId: string,
  items: readonly {
    url: string
    /** The source whose `parseRef` claimed this URL, or null when none did (or docs are unwired). */
    claimedBy: DocumentSourceKind | null
    doc: DocumentRecord | null
    task: TaskRecord | null
  }[],
): void {
  if (!logger) return
  for (const item of items) {
    if (!item.claimedBy || item.doc || item.task) continue
    logger.info('a linked-context url looks like a document-source page but nothing is imported', {
      blockId,
      // A pasted link can carry a signed/`?token=` query, and this one reaches the log verbatim.
      url: redactSecrets(item.url),
      source: item.claimedBy,
    })
  }
}

/** Map a document record to the agent-context doc shape (summary index + materialisable body). */
function toContextDoc(d: DocumentRecord, freshness?: DocumentFreshness): LinkedContextDoc {
  return {
    externalId: d.externalId,
    title: d.title,
    url: d.url,
    origin: d.source,
    excerpt: d.excerpt,
    summary: buildExcerpt(d.body || d.excerpt, CONTEXT_BUDGET.summaryChars),
    body: d.body,
    ...(freshness ? { freshness } : {}),
  }
}

/** Map a task record to the agent-context task shape (adds the index `summary`). */
function toContextTask(
  t: TaskRecord,
): NonNullable<AgentRunContext['block']['contextTasks']>[number] {
  return {
    key: t.externalId,
    url: t.url,
    title: t.title,
    status: t.status,
    type: t.type,
    assignee: t.assignee,
    priority: t.priority,
    labels: t.labels,
    description: t.description,
    comments: t.comments,
    summary: buildExcerpt(t.description || t.title, CONTEXT_BUDGET.summaryChars),
  }
}

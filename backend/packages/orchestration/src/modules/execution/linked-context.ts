import type {
  AgentRunContext,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceKind,
  TaskRecord,
  TaskRepository,
} from '@cat-factory/kernel'
import { buildExcerpt, CONTEXT_BUDGET } from '@cat-factory/kernel'
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
}

/**
 * Build the URL→document canonicaliser from the configured document providers, so a Figma/Notion
 * link pasted into prose auto-matches its imported page even when it carries a title segment or
 * tracking params the stored canonical url omits. No providers ⇒ undefined (url-string match only).
 */
export function makeDocumentUrlResolver(
  providers: readonly { kind: DocumentSourceKind; parseRef: (url: string) => string | null }[] = [],
): DocumentUrlResolver | undefined {
  if (!providers.length) return undefined
  return (url: string) => {
    for (const provider of providers) {
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
}): LinkedContextSources {
  const documentUrlResolver = makeDocumentUrlResolver(deps.documentSourceProviders)
  return {
    ...(deps.documentRepository ? { documents: deps.documentRepository } : {}),
    ...(deps.taskRepository ? { tasks: deps.taskRepository } : {}),
    ...(documentUrlResolver ? { documentUrlResolver } : {}),
  }
}

/** The resolved context, in the exact shape `AgentRunContext.block` carries it. */
export interface LinkedContext {
  docs: NonNullable<AgentRunContext['block']['contextDocs']>
  tasks: NonNullable<AgentRunContext['block']['contextTasks']>
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
 */
export async function resolveLinkedContext(
  sources: LinkedContextSources,
  workspaceId: string,
  blockId: string,
  description: string,
  opts: { includeLinked: boolean },
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
        return { doc, task }
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

  return {
    docs: [...docs.values()].map((d) => toContextDoc(d)),
    tasks: [...tasks.values()].map((t) => toContextTask(t)),
  }
}

/** Map a document record to the agent-context doc shape (summary index + materialisable body). */
export function toContextDoc(
  d: DocumentRecord,
): NonNullable<AgentRunContext['block']['contextDocs']>[number] {
  return {
    title: d.title,
    url: d.url,
    excerpt: d.excerpt,
    summary: buildExcerpt(d.body || d.excerpt, CONTEXT_BUDGET.summaryChars),
    body: d.body,
  }
}

/** Map a task record to the agent-context task shape (adds the index `summary`). */
export function toContextTask(
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

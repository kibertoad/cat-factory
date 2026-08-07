import type {
  DocumentFreshness,
  ExecutionInstance,
  PrReportContextDocument,
  PrVerificationReport,
  StepContextDocument,
} from '@cat-factory/kernel'
import { describeFreshnessGap, hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { absentNote } from './prReport.steps.js'

// ---------------------------------------------------------------------------
// The PR verification report's CONTEXT SOURCES section: what the run built FROM.
//
// Every other section answers what the run produced and what checked it. This one answers the
// question underneath them, and it is the only one a reviewer cannot reconstruct from the repo:
// which linked documents the agents read, and at which revision. The dispatch-time freshness
// check already computes the verdict and renders it into the agent's context, where it does its
// job and vanishes with the container; each dispatch RECORDS it on its step
// (`step.contextDocuments`), and this module reduces those records over the run.
//
// Nothing here re-probes a source. By compose time the source has moved on, so a fresh probe
// would answer about a revision no agent on this run ever read — the report would disagree with
// the run it describes, which is the one failure the whole feature exists to prevent.
//
// Its own module rather than another arm of `prReport.logic.ts`: the reduction over steps (a
// document read by five dispatches is one row, and whether the revision MOVED between them is
// derived) is a cohesive concern with its own tests, and the spine is at its size budget.
// ---------------------------------------------------------------------------

/**
 * The identity two dispatches' records of one document agree on.
 *
 * The SOURCE identity, not anything the row displays: an `upload` carries no URL, so a key
 * falling back to the title would fold two same-titled uploads into one row and read their
 * differing revisions as a single page that moved mid-run. Same pair the document repository and
 * the linked-context resolver key by, so a row here is the same document those do.
 */
function documentKey(doc: StepContextDocument): string {
  return `${doc.origin}:${doc.externalId}`
}

/** The revision a verdict names, or null when it names none (every non-`confirmed` verdict). */
function revisionOf(freshness: DocumentFreshness | undefined): string | null {
  return freshness?.status === 'confirmed' ? freshness.version : null
}

/**
 * Reduce every dispatch's record into one row per document.
 *
 * The verdict kept is the LAST one recorded, because that is the state the run ended on and the
 * one a reviewer opening the source now can check against. What the last verdict cannot say is
 * that the design MOVED under the run, so that is derived separately from the distinct revisions
 * the run saw: a coder step that finished before a designer's edit and a merger step that ran
 * after it read different designs, and a row showing only the final revision reads as though
 * every step had it.
 *
 * First-seen order, so the section lists documents in the order the run's own steps read them.
 */
function reduceDocuments(instance: ExecutionInstance): PrReportContextDocument[] {
  const rows = new Map<string, PrReportContextDocument>()
  const revisions = new Map<string, Set<string>>()
  for (const step of instance.steps) {
    for (const doc of step.contextDocuments ?? []) {
      const key = documentKey(doc)
      const seen = revisions.get(key) ?? new Set<string>()
      const revision = revisionOf(doc.freshness)
      if (revision) seen.add(revision)
      revisions.set(key, seen)
      rows.set(key, {
        // A document title is authored by whoever owns the page, so it lands in a host-parsed PR
        // body as untrusted text like every other hole in this report; the scrub is applied at
        // COMPOSE time so the prose and the JSON block carry the same value.
        title: redactSecrets(doc.title) ?? '',
        url: doc.url || null,
        origin: doc.origin,
        ...(doc.freshness ? { freshness: doc.freshness } : {}),
        movedDuringRun: seen.size > 1,
      })
    }
  }
  return [...rows.values()]
}

/**
 * Compose the section from the run's own recorded state.
 *
 * `absent` states exactly one fact, and the note may not state a stronger one: no dispatch on
 * this run PUT a linked document in front of its agent. Reading that back as "the task linked
 * nothing" is wrong for the case this feature is aimed at. A run whose requirements were
 * incorporated resolves its attachments once, into the reworked brief, and every dispatch after
 * that carries only what the brief NAMES, so a task with an attached design lands here. So does a
 * run whose steps assembled their context outside the dispatch builder (the inline requirements
 * review), and one that predates the record. None of the four is a document the report is failing
 * to show, and only one of them is the task having linked nothing.
 */
export function composeContext(
  instance: ExecutionInstance,
  cap: <T>(items: readonly T[], label: string) => T[],
): PrVerificationReport['context'] {
  const documents = reduceDocuments(instance)
  if (!documents.length) {
    return {
      status: 'absent',
      note:
        'No dispatch on this run put a linked document in front of its agent. Usually that is a ' +
        'task with no attached page and no document URL in its description, so the description ' +
        'was the whole brief; a run whose requirements were incorporated first carries the ' +
        'attachments folded into that brief instead, and records nothing here either.',
      documents: [],
    }
  }
  return { status: 'reported', documents: cap(documents, 'context.documents') }
}

/**
 * What one row says about how current the copy the agents read was.
 *
 * Four outcomes, kept apart because they call for four different reviewer reactions: a named
 * revision to check the design against, a copy nobody could confirm (which is a warning about
 * the WORK, not about the platform), an uploaded body with no source to trail, and a deployment
 * that runs no freshness check at all. Collapsing any two of them would put a reassuring dash in
 * a cell whose whole job is to say what is not known.
 */
function renderRevision(freshness: DocumentFreshness | undefined): string {
  if (!freshness) return 'not checked'
  switch (freshness.status) {
    case 'confirmed':
      return hostMarkdown.codeCell(freshness.version)
    case 'not-applicable':
      return 'no source to compare against'
    case 'unconfirmed':
      return `⚠️ unconfirmed (${hostMarkdown.cell(describeFreshnessGap(freshness.reason))})`
    default:
      return exhaustiveFreshness(freshness)
  }
}

/** The compile-time totality guard, so a new verdict member fails the build rather than a cell. */
function exhaustiveFreshness(freshness: never): string {
  return `unknown (${JSON.stringify(freshness)})`
}

/**
 * Render the section.
 *
 * The moved-during-run call-out LEADS when there is one, for the same reason the requirement
 * table's regression count does: it is the reading a reviewer would otherwise have to derive by
 * comparing timestamps they do not have, and it changes what "the implementation does not match
 * the design" means.
 */
export function renderContext(context: PrVerificationReport['context']): string[] {
  const out = ['### Context sources', '']
  if (context.status === 'absent') return [...out, absentNote(context.note), '']
  const moved = context.documents.filter((doc) => doc.movedDuringRun)
  if (moved.length) {
    out.push(
      `**🔄 ${moved.length} document${moved.length === 1 ? '' : 's'} changed while this run was ` +
        `in flight**: earlier steps built against a revision the later ones did not read. ` +
        `Check the work against the revision below rather than against what the source shows now.`,
      '',
    )
  }
  out.push('| Document | Source | Revision read |', '| --- | --- | --- |')
  for (const doc of context.documents) {
    const title = hostMarkdown.cellLink(doc.title, doc.url)
    const revision = renderRevision(doc.freshness) + (doc.movedDuringRun ? ' 🔄' : '')
    out.push(`| ${title} | ${hostMarkdown.cell(doc.origin)} | ${revision} |`)
  }
  return [...out, '']
}

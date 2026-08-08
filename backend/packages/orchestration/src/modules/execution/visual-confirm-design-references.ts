import type {
  BinaryArtifactRecord,
  BinaryArtifactStore,
  DocumentArtifactRef,
  DocumentRecord,
  DocumentRepository,
} from '@cat-factory/kernel'
import type {
  DocumentRenderStatus,
  VisualConfirmDesignGap,
  VisualConfirmDesignGapReason,
  VisualConfirmDesignReferences,
} from '@cat-factory/contracts'
import { isDesignSource } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The visual-confirmation gate's DESIGN-ORIGIN reference half: the rendered frames an import
// retained for the designs a task links, folded into the gate's gallery beside the images a
// person uploaded by hand.
//
// Its own module rather than more methods on `VisualConfirmationController` because the fold is
// pure and the interesting part: which frame wins a view, what a name collision across two
// designs means, and which of five ways a design can contribute nothing the reviewer is looking
// at. The controller keeps the one impure step (two reads) and hands the rest here.
// ---------------------------------------------------------------------------

/**
 * How many design-rendered views one gallery may carry, across every design a task links.
 *
 * A per-document render cap already bounds each design (Figma rasterises the first frames of a
 * file, not all of them), and this bounds their SUM: a task linking four designs would otherwise
 * push a couple of captured screenshots off the bottom of a page of mocks nobody asked to review
 * here. Whatever it excludes is COUNTED and stated, never quietly trimmed.
 */
export const MAX_DESIGN_REFERENCE_VIEWS = 12

/** One design-rendered frame, keyed by the view name it pairs on. */
export interface DesignReference {
  view: string
  artifactId: string
  /**
   * The stored image's MIME type. Carried because a consumer that WRITES the frame to disk (the
   * container delivery) has to name the file, and a `.png` over a JPEG is a lie an image loader
   * is entitled to act on. The gate itself never reads it: it serves the bytes through the blob
   * endpoint, which reads the type off the same record.
   */
  contentType: string
}

/** The fold's product: what to show, and what to say about what is missing. */
export interface DesignReferenceFold {
  references: DesignReference[]
  summary: VisualConfirmDesignReferences
}

/** The document fields the fold reads; a `DocumentRecord` structurally satisfies it. */
export interface DesignDocumentSummary {
  source: DocumentRecord['source']
  externalId: string
  title: string
  renderStatus: DocumentRenderStatus | null
}

/**
 * Why a linked design contributed less than its whole set of frames, or null when it contributed
 * everything it has.
 *
 * Reads the stored `renderStatus` AND what the artifact store actually holds, because the two can
 * disagree in the one direction that matters: a row CLAIMING retention over an empty shelf (an
 * account that re-pointed its blob backend, a reclaim that outran its re-import) would otherwise
 * describe a gallery that is not there. `partial` is such a claim just as `stored` is, and left to
 * speak for itself it tells the reviewer "only part of its frames were retained" above nothing at
 * all, which reads as a design that is merely short rather than one that is absent, and sends them
 * looking for the frames that did survive.
 *
 * So the two claiming statuses are checked against what is held, and the three that already say
 * nothing was kept (`failed` / `none` / `storage_unavailable`) stand as they are: each names a
 * DIFFERENT cause of the same empty shelf, and collapsing them would throw the cause away.
 */
export function designGapReason(
  renderStatus: DocumentRenderStatus | null,
  heldImages: number,
): VisualConfirmDesignGapReason | null {
  switch (renderStatus) {
    case 'stored':
      return heldImages > 0 ? null : 'not_retained'
    case 'partial':
      return heldImages > 0 ? 'partial' : 'not_retained'
    case 'failed':
      return 'failed'
    case 'none':
      return 'none'
    case 'storage_unavailable':
      return 'storage_unavailable'
    case null:
      // No render outcome was ever recorded for this document. Two causes the gate cannot tell
      // apart (a source that rasterises nothing, a document imported before renders were kept),
      // and one answer covers both honestly; a re-import is what distinguishes them.
      return heldImages > 0 ? null : 'not_retained'
    default:
      return exhaustiveRenderStatus(renderStatus)
  }
}

/**
 * The compile-time totality guard: a new {@link DocumentRenderStatus} member fails the build here
 * rather than silently becoming "this design is complete".
 */
function exhaustiveRenderStatus(status: never): VisualConfirmDesignGapReason {
  void status
  return 'not_retained'
}

/** The stable key both sides of the join use: a document's own source identity. */
function documentKey(ref: DocumentArtifactRef): string {
  return `${ref.source}::${ref.externalId}`
}

/**
 * A per-document display label that is UNIQUE within this fold, used to qualify a view name two
 * designs both claim. Titles alone are not unique (two boards can import files named "Checkout
 * flow"), so a shared title falls back to carrying the source id.
 */
function documentLabels(documents: readonly DesignDocumentSummary[]): Map<string, string> {
  const byTitle = new Map<string, number>()
  for (const document of documents) {
    byTitle.set(document.title, (byTitle.get(document.title) ?? 0) + 1)
  }
  const labels = new Map<string, string>()
  for (const document of documents) {
    const shared = (byTitle.get(document.title) ?? 0) > 1
    labels.set(
      documentKey(document),
      shared ? `${document.title} ${document.externalId}` : document.title,
    )
  }
  return labels
}

/**
 * Share a bounded budget of gallery slots across the designs competing for it, one slot at a time
 * in turn, and answer how many each may take.
 *
 * The budget is shared, so how it is SPLIT is a decision, and taking the first `cap` views in read
 * order is the one shape that answers it worst: reads come back oldest-first, so the design linked
 * longest ago fills the gallery and a design linked this morning contributes nothing, its absence
 * indistinguishable to the reviewer from a design with no frames. Round-robin instead: every
 * design is represented before any design gets a second slot, a design with fewer frames than its
 * share leaves the rest to the others, and the split does not move when the links are re-ordered.
 */
function allocate(counts: readonly number[], cap: number): number[] {
  const taken = counts.map(() => 0)
  let remaining = Math.max(0, cap)
  for (let round = 0; remaining > 0; round += 1) {
    let servedThisRound = false
    for (let i = 0; i < counts.length && remaining > 0; i += 1) {
      if (round >= counts[i]!) continue
      taken[i]! += 1
      remaining -= 1
      servedThisRound = true
    }
    // Nobody had a frame left at this depth, so nobody will at any greater one.
    if (!servedThisRound) break
  }
  return taken
}

/**
 * Fold a task's design documents and their retained renders into the gate's reference set.
 *
 * Four rules, each of which the obvious shape gets wrong:
 *
 * A view name claimed by TWO designs is qualified with its design's label on BOTH sides, never
 * just the second. This is the same rule slice 1 applied to a frame name repeated across pages
 * within one file: leaving the first occurrence bare hands the plain name to whichever document
 * happened to be read first, so re-ordering the links would silently re-point a reviewed view at
 * a different screen. The cost is that neither qualified name matches a screenshot captured as
 * plain "Checkout", which is correct: nothing knows which of two designs that capture is of.
 *
 * Within ONE design, the NEWEST render for a view wins. The artifact reads are ordered oldest
 * first, so a later assignment overriding an earlier one is the rule, not an accident.
 *
 * The cap counts VIEWS, not artifacts, and is applied after the per-view reduction: capping the
 * raw rows first would spend the budget on frames a later revision had already replaced. It is
 * SHARED across the linked designs rather than consumed in read order (see {@link allocate}), and
 * what it cuts is named per design, not just totalled.
 *
 * Emission stays in document order with each design's own frames contiguous: the allocation
 * decides how many slots each design gets, never how the gallery reads.
 */
export function foldDesignReferences(
  documents: readonly DesignDocumentSummary[],
  artifacts: readonly BinaryArtifactRecord[],
  cap = MAX_DESIGN_REFERENCE_VIEWS,
): DesignReferenceFold {
  // One entry per document IDENTITY, in first-linked order. A repeated link is one design: counted
  // twice it would take two shares of the budget, state its gap twice, and make its own title look
  // shared to the qualifier below, which would then qualify every one of its views against itself.
  const known = new Map(documents.map((document) => [documentKey(document), document] as const))
  const unique = [...known.values()]
  const renders = artifacts.filter(
    (record) =>
      record.kind === 'reference' && record.document && known.has(documentKey(record.document)),
  )
  // Which documents claim each raw view name: the collision test the qualification below runs on.
  const claimants = new Map<string, Set<string>>()
  for (const record of renders) {
    const view = record.view
    if (!view) continue
    const key = documentKey(record.document!)
    const held = claimants.get(view)
    if (held) held.add(key)
    else claimants.set(view, new Set([key]))
  }
  const labels = documentLabels(unique)
  const byDocument = new Map(
    unique.map((document) => [
      documentKey(document),
      new Map<string, { artifactId: string; contentType: string }>(),
    ]),
  )
  const heldPerDocument = new Map<string, number>()
  for (const record of renders) {
    // A render with no view has no pairing key, so it can only ever be shown against nothing.
    // Counted for its document (it IS retained) but not rendered as a pair.
    const key = documentKey(record.document!)
    heldPerDocument.set(key, (heldPerDocument.get(key) ?? 0) + 1)
    if (!record.view) continue
    const contested = (claimants.get(record.view)?.size ?? 0) > 1
    const view = contested ? `${record.view} (${labels.get(key) ?? key})` : record.view
    byDocument.get(key)!.set(view, { artifactId: record.id, contentType: record.contentType })
  }
  const offered = unique.map((document) => [...byDocument.get(documentKey(document))!.entries()])
  const taken = allocate(
    offered.map((views) => views.length),
    cap,
  )
  const references = offered.flatMap((views, index) =>
    views.slice(0, taken[index]!).map(([view, render]) => ({ view, ...render })),
  )
  const gaps: VisualConfirmDesignGap[] = []
  let dropped = 0
  unique.forEach((document, index) => {
    const cut = offered[index]!.length - taken[index]!
    dropped += cut
    const reason = designGapReason(
      document.renderStatus,
      heldPerDocument.get(documentKey(document)) ?? 0,
    )
    // The two ways a design falls short are independent, so one entry carries both: a design can
    // be short at its source, short at the gallery ceiling, or both at once.
    if (reason || cut > 0) {
      gaps.push({ title: document.title, reason, ...(cut > 0 ? { dropped: cut } : {}) })
    }
  })
  return {
    references,
    summary: {
      documents: unique.length,
      images: references.length,
      ...(dropped > 0 ? { dropped } : {}),
      ...(gaps.length ? { gaps } : {}),
    },
  }
}

/**
 * Read the task's linked DESIGN documents and their retained renders, then fold them.
 *
 * Returns null when the task links no design at all, which is a different fact from a design that
 * gave nothing: the first has nothing to state and the second is exactly what the summary exists
 * to say. Two reads regardless of how many designs are attached (the batched
 * {@link BinaryArtifactStore.listByDocuments}), because this runs on the driver path of every run
 * whose pipeline carries the gate.
 *
 * The documents are read LIVE at gather time rather than off the run's recorded context, for the
 * same reason the hand-uploaded references are: `recapture` exists so a person can attach a
 * missing reference mid-review and see it, and a design linked while the gate is parked is that
 * same act.
 */
export async function resolveDesignReferences(
  documentRepository: DocumentRepository | undefined,
  store: BinaryArtifactStore | null,
  workspaceId: string,
  blockId: string,
): Promise<DesignReferenceFold | null> {
  if (!documentRepository || !store) return null
  const linked = await documentRepository.listByBlock(workspaceId, blockId)
  const designs: DesignDocumentSummary[] = linked
    .filter((document) => isDesignSource(document.source))
    .map((document) => ({
      source: document.source,
      externalId: document.externalId,
      title: document.title,
      renderStatus: document.renderStatus,
    }))
  if (!designs.length) return null
  const artifacts = await store.listByDocuments(
    workspaceId,
    designs.map((document) => ({ source: document.source, externalId: document.externalId })),
  )
  return foldDesignReferences(designs, artifacts)
}

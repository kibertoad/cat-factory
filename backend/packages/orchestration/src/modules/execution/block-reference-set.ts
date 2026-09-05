import type {
  BinaryArtifactRecord,
  BinaryArtifactStore,
  DocumentRepository,
} from '@cat-factory/kernel'
import type { VisualConfirmDesignReferences } from '@cat-factory/contracts'
import type { DesignReference } from './visual-confirm-design-references.js'
import { resolveDesignReferences } from './visual-confirm-design-references.js'

// ---------------------------------------------------------------------------
// WHICH reference image a task holds for each view, from both of its producers: the frames an
// import retained for the designs the task links, and the images a person uploaded against the
// task itself.
//
// Its own module because there are now TWO readers of that answer and they must not each derive
// it. The visual-confirmation gate pairs captured screenshots against it, and a dispatch of a
// CAPTURING kind hands the same set to the container so the tester names its views after the
// files it was given. A second derivation would let the two disagree about a view name, which is
// precisely the join the gate performs: the pairing would silently fall apart while both halves
// looked correct on their own.
// ---------------------------------------------------------------------------

/** The view name an uploaded reference with no view of its own is filed under. */
const UNNAMED_REFERENCE_VIEW = '(reference)'

/** One view's reference image, and which producer it came from. */
export interface BlockReference {
  view: string
  artifactId: string
  /** The stored image's MIME type, so a consumer writing it to disk can name the file honestly. */
  contentType: string
  /** `design` = a frame an import retained; `upload` = an image a person attached to the task. */
  origin: 'design' | 'upload'
}

/** The reference set, beside what the linked designs did NOT contribute. */
export interface BlockReferenceSet {
  references: BlockReference[]
  /**
   * What the task's linked designs contributed, gaps included, or null when it links no design.
   * Carried beside the set rather than folded into it: "one design is attached and gave nothing"
   * is a fact only this read knows, and an empty reference list cannot state it.
   */
  design: VisualConfirmDesignReferences | null
}

/**
 * Merge the two producers into one reference per view.
 *
 * An UPLOAD outranks a design frame for the same view: an upload is a deliberate act against this
 * one task and survives every re-import, while a design render is a projection of a live document
 * that the next body-changing import replaces wholesale. So the design frames are laid down first
 * and the uploads assign over them.
 *
 * Within the uploads, the LAST one wins, because `listByBlock` returns them oldest-first and a
 * person re-uploading a corrected reference for a view they already populated must override the
 * stale one rather than be discarded.
 *
 * Emission keeps the design frames' order and appends the views only the uploads introduce, so a
 * caller rendering the set in order shows each design's frames contiguously (the order
 * {@link foldDesignReferences} chose) rather than in artifact-id order.
 */
export function mergeBlockReferences(
  design: readonly DesignReference[],
  uploads: readonly BinaryArtifactRecord[],
): BlockReference[] {
  const byView = new Map<string, BlockReference>()
  for (const frame of design) {
    byView.set(frame.view, { ...frame, origin: 'design' })
  }
  for (const upload of uploads) {
    const view = upload.view ?? UNNAMED_REFERENCE_VIEW
    byView.set(view, {
      view,
      artifactId: upload.id,
      contentType: upload.contentType,
      origin: 'upload',
    })
  }
  return [...byView.values()]
}

/**
 * Read a task's reference images: its linked designs' retained frames plus its own uploads.
 *
 * Read LIVE by every caller rather than off recorded run state, because attaching a reference (or
 * linking a design) mid-review is exactly the act `recapture` exists to pick up, and a dispatch
 * resolves the set at the moment the job starts for the same reason.
 *
 * A caller with no artifact store wired gets an empty set and a null design summary: with nowhere
 * to hold bytes there are no references to have, which is the same answer on both halves.
 */
export async function resolveBlockReferences(
  documentRepository: DocumentRepository | undefined,
  store: BinaryArtifactStore | null,
  workspaceId: string,
  blockId: string,
): Promise<BlockReferenceSet> {
  if (!store) return { references: [], design: null }
  const design = await resolveDesignReferences(documentRepository, store, workspaceId, blockId)
  const uploads = (await store.listByBlock(workspaceId, blockId)).filter(
    (record) => record.kind === 'reference',
  )
  return {
    references: mergeBlockReferences(design?.references ?? [], uploads),
    design: design?.summary ?? null,
  }
}

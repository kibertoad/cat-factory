import type { ReferenceScreenshot } from '@cat-factory/kernel'
import type { BlockReference } from './block-reference-set.js'

// ---------------------------------------------------------------------------
// The container half of a task's reference designs: turning the reference SET (which artifact is
// the reference for each view) into the FILES a capturing agent reads off disk under
// `.cat-context/reference-screenshots/`.
//
// The naming happens in the engine rather than in the container for one reason: the file name is
// how the agent learns the view name, and the view name is what the gate pairs on. Left to the
// harness, a sanitiser change in an image the deployment has not rolled out yet would rename the
// views a run reports, and every pair would come apart with nothing failing.
// ---------------------------------------------------------------------------

/** The file extension written for each stored image type; anything else falls back to `.png`. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * A single safe path segment derived from a view name: no separators, no traversal, no leading
 * dot, and short enough for any filesystem. Everything outside a conservative set collapses to
 * `-`, which is lossy ON PURPOSE: the file name is a HANDLE the agent types back, and the view
 * it stands for is stated beside it in the prompt, so legibility beats fidelity here.
 */
function slugify(view: string): string {
  const slug = view
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'view'
}

/**
 * Name each reference's file, keeping the names UNIQUE within the run.
 *
 * Two different views can slug to one name (`Checkout / step 1` and `Checkout — step 1`), and
 * dropping one of them would hand the agent a directory quietly missing a screen it is being
 * asked to compare. So a collision is suffixed with its ordinal instead, in reference order:
 * deterministic, and the prompt states which view each file is, so the suffix never has to be
 * interpreted.
 */
export function assignFileNames(references: readonly BlockReference[]): string[] {
  const used = new Set<string>()
  return references.map((reference) => {
    const extension = EXTENSIONS[reference.contentType] ?? 'png'
    const base = slugify(reference.view)
    let candidate = `${base}.${extension}`
    for (let n = 2; used.has(candidate); n += 1) candidate = `${base}-${n}.${extension}`
    used.add(candidate)
    return candidate
  })
}

/** {@link assignFileNames}, projected onto the capture manifest's own shape. */
export function nameReferenceFiles(references: readonly BlockReference[]): ReferenceScreenshot[] {
  const names = assignFileNames(references)
  return references.map((reference, index) => ({
    view: reference.view,
    artifactId: reference.artifactId,
    fileName: names[index]!,
  }))
}

/**
 * How many references one dispatch is handed.
 *
 * A task's set is UNBOUNDED from here: a person may attach a hundred images to one block, and a
 * design's retained frames sit beside them. The container downloads every one before the agent's
 * first turn, in a pass deliberately budgeted well under the inactivity watchdog, so an unbounded
 * set does not degrade gracefully — it spends the whole budget and delivers a random prefix of
 * whatever finished. A ceiling here makes the set a decision the engine states rather than an
 * accident of transfer speed. The harness keeps its own (higher) backstop against a malformed
 * body; this is the number that should ever actually bind.
 */
export const MAX_REFERENCE_SCREENSHOTS = 24

/**
 * Apply a `limit` to a reference set, choosing what to DROP rather than truncating.
 *
 * The limit is the CALLER's, because the two consumers of a task's references bound themselves for
 * different reasons and by different amounts: a capture spends transfer time per image
 * ({@link MAX_REFERENCE_SCREENSHOTS}), while an attachment spends input tokens on every turn
 * ({@link MAX_DESIGN_IMAGES}), which is far tighter. One shared number would have to be the
 * smaller, silently starving the capture set.
 *
 * A plain prefix would fall on the uploads, because {@link mergeBlockReferences} emits the design
 * frames first and appends the views only the uploads introduce. That is exactly backwards: the
 * same precedence rule that lets an upload override a design frame for one view says an upload is
 * the more deliberate artifact, so it is the LAST thing a cap should discard. Uploads are kept
 * first and design frames fill the remainder.
 *
 * Emission order is the original one either way, so a caller rendering the set still shows each
 * design's frames contiguously and the file names stay in gallery order.
 */
export function capReferences(
  references: readonly BlockReference[],
  limit: number,
): {
  kept: BlockReference[]
  omitted: string[]
} {
  if (references.length <= limit) {
    return { kept: [...references], omitted: [] }
  }
  const keep = new Set<BlockReference>()
  for (const pass of ['upload', 'design'] as const) {
    for (const reference of references) {
      if (keep.size >= limit) break
      if (reference.origin === pass) keep.add(reference)
    }
  }
  return {
    kept: references.filter((reference) => keep.has(reference)),
    omitted: references.filter((reference) => !keep.has(reference)).map((r) => r.view),
  }
}

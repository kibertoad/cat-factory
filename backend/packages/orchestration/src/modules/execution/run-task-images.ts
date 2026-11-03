import type { BinaryArtifactRecord, DesignImageSet } from '@cat-factory/kernel'
import { MAX_TASK_IMAGES } from '@cat-factory/contracts'
import { assignFileNames } from './run-reference-screenshots.js'

/** The name an attached image with no name of its own is listed under. */
const UNNAMED_TASK_IMAGE = 'attached image'

/**
 * The images a person attached to a task, as the set a dispatch hands its agents, or `undefined`
 * when the task has none (the ordinary case, which a prompt spends no line on).
 *
 * Read from the block's artifacts the caller already listed, oldest first, so the agents see them
 * in the order they were attached. Capped at {@link MAX_TASK_IMAGES}, which the upload enforces
 * too, so `omitted` is non-empty only for rows that predate a lower ceiling; it is still stated
 * rather than dropped, because a silently shortened list reads as the whole task.
 */
export function taskImageSet(
  blockArtifacts: readonly BinaryArtifactRecord[],
): DesignImageSet | undefined {
  const attached = blockArtifacts
    .filter((record) => record.kind === 'context')
    .map((record) => ({
      view: record.view ?? UNNAMED_TASK_IMAGE,
      artifactId: record.id,
      contentType: record.contentType,
    }))
  if (!attached.length) return undefined
  const kept = attached.slice(0, MAX_TASK_IMAGES)
  const names = assignFileNames(kept)
  return {
    files: kept.map((image, index) => ({ ...image, fileName: names[index]! })),
    omitted: attached.slice(MAX_TASK_IMAGES).map((image) => image.view),
  }
}

import type { Block, Logger, ModelRef, ResolveBinaryArtifactStore } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  imageParts,
  inlineImageStore,
  prepareInlineImages,
  renderTaskImages,
} from '@cat-factory/agents'
import { taskImageSet } from '../execution/run-task-images.js'

/** What an inline review call's prompt needs from the task's attached images. */
export interface ReviewTaskImageDeps {
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  runsInline?: (ref: ModelRef) => boolean
  logger?: Logger
}

/**
 * The request body of one inline review call: the prompt plus the images attached to the task
 * under review, as a spread-ready `{ prompt }` or `{ messages }`.
 *
 * The reviewers judge a task's description, and an image its author attached is part of that
 * description, so the call carries it as image input wherever the model takes one and STATES it
 * otherwise. A task with no attached image (most of them) gets the plain prompt, byte-identical.
 *
 * No store failure fails a review. A LISTING that failed cannot say whether the task had images,
 * so it adds nothing to the prompt; a BYTE read that failed after the listing named the images
 * settles as `transfer_failed`, so the prompt states that they were withheld.
 */
export async function reviewRequestWithTaskImages(
  deps: ReviewTaskImageDeps,
  workspaceId: string,
  block: Block,
  ref: ModelRef,
  prompt: string,
) {
  const logger = deps.logger ?? noopLogger
  // Resolved once for the listing and the byte reads both.
  const store = inlineImageStore(deps.resolveBinaryArtifactStore, workspaceId)
  const set = store
    ? await runBestEffort(
        logger,
        'review: read task images',
        async () => {
          const resolved = await store()
          return resolved
            ? taskImageSet(await resolved.listByBlock(workspaceId, block.id))
            : undefined
        },
        { workspaceId, blockId: block.id },
      )
    : undefined
  const prepared = await prepareInlineImages({
    set,
    ref,
    textOnly: deps.runsInline?.(ref) ?? false,
    store,
    workspaceId,
    logger,
  })
  const text = prompt + renderTaskImages(prepared.outcome?.set, prepared.outcome?.delivery)
  return prepared.images.length
    ? {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text }, ...imageParts(prepared.images)],
          },
        ],
      }
    : { prompt: text }
}

import type { ImageManifestSpec } from './job.js'
import type { Logger } from './logger.js'
import { deliverDesignImages } from './design-images.js'
import { deliverReferenceScreenshots } from './reference-screenshots.js'
import { deliverTaskImages } from './task-images.js'

// ---------------------------------------------------------------------------
// Every image delivery of one job, in one call.
//
// A job can legitimately carry several manifests (a capturing kind that also builds), and every
// agent-running flow has to perform all or none: a flow that did half would leave the agent
// with a directory it was told about and never got, which is invisible until the output degrades.
// One entry point makes that impossible to get half-right, the same reason `agentCapabilities`
// exists for the fields these come from.
// ---------------------------------------------------------------------------

/** The manifests a job may carry, as they sit on any agent-running spec. */
export interface JobImageSpecs {
  referenceScreenshots?: ImageManifestSpec
  designImages?: ImageManifestSpec
  taskImages?: ImageManifestSpec
}

/**
 * Deliver every manifest into the checkout and answer the prompt text they contribute.
 *
 * The blocks are CONCATENATED rather than kept apart because they say the same kind of thing
 * (what this container actually holds, against what the run was told it would), and the agent reads
 * one context. Each is empty when its manifest is absent or when nothing needs saying, so a
 * job with one manifest is byte-identical to what it produced before the other existed.
 *
 * Runs once per PASS, not once per job: a coding flow re-enters its workspace for every repair
 * round. That is safe because each delivery is idempotent over the checkout (a file already on disk
 * is counted, never re-fetched), so a later round costs a stat per image and cannot report a view an
 * earlier round successfully delivered as absent. A view that MISSED is retried, which is the
 * behaviour worth having: the next round is a fresh chance at a blob backend that was briefly down.
 */
export async function deliverJobImages(
  spec: JobImageSpecs & { dir: string },
  options: { signal?: AbortSignal; log: Logger; fetchImpl?: typeof fetch },
): Promise<string> {
  const references = await deliverReferenceScreenshots(spec.dir, spec.referenceScreenshots, options)
  const designs = await deliverDesignImages(spec.dir, spec.designImages, options)
  const attached = await deliverTaskImages(spec.dir, spec.taskImages, options)
  return `${references}${designs}${attached}`
}

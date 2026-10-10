import type { ImageManifestSpec } from './job.js'
import type { Logger } from './logger.js'
import { CONTEXT_DIR } from './pi.js'
import { type ContextImageOutcome, materializeContextImages } from './context-images.js'

// ---------------------------------------------------------------------------
// REFERENCE DESIGNS on disk for a CAPTURING kind: the images a UI tester compares its own
// screenshots against, in `.cat-context/reference-screenshots/` — the directory the UI-tester
// prompt has always named and nothing wrote.
//
// The transfer itself lives in `context-images.ts`, shared with the design-picture delivery. What
// stays here is what makes this manifest a CAPTURE instruction: the directory, and the prompt block
// telling the tester to name each screenshot after the view it was handed, including the views it
// was handed no image for.
// ---------------------------------------------------------------------------

/** Subdirectory of {@link CONTEXT_DIR} the reference designs are written to. */
export const REFERENCE_SCREENSHOT_SUBDIR = 'reference-screenshots'

/** The relative directory the references are written to (what the prompt points the agent at). */
export const REFERENCE_SCREENSHOT_DIR = `${CONTEXT_DIR}/${REFERENCE_SCREENSHOT_SUBDIR}`

/** Download this job's capture references. See {@link materializeContextImages}. */
export function materializeReferenceScreenshots(
  cwd: string,
  spec: ImageManifestSpec,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ContextImageOutcome> {
  return materializeContextImages(cwd, REFERENCE_SCREENSHOT_SUBDIR, spec, options)
}

/**
 * The whole delivery in one call: download the manifest (when there is one) and answer the prompt
 * block naming what landed, reporting any miss to the operator on the way.
 *
 * One entry point so an agent-running flow cannot end up doing half of it. A miss is stated to the
 * AGENT in its prompt (it still has to capture that view) AND logged here, because a reference that
 * never arrives is otherwise invisible in the run's output: the gallery simply pairs against
 * nothing, months later, with no line anywhere saying why.
 */
export async function deliverReferenceScreenshots(
  cwd: string,
  spec: ImageManifestSpec | undefined,
  options: { signal?: AbortSignal; log: Logger; fetchImpl?: typeof fetch },
): Promise<string> {
  if (!spec) return ''
  const outcome = await materializeReferenceScreenshots(cwd, spec, options)
  if (outcome.missing.length) {
    options.log.warn('agent: some reference designs are not on disk', {
      written: outcome.written.length,
      missing: outcome.missing.length,
      reasons: outcome.missing.map((file) => file.reason).slice(0, 5),
    })
  }
  return referenceScreenshotGuidance(outcome)
}

/**
 * The prompt block naming what the agent was handed, or '' when the pass produced nothing at all.
 *
 * States the MISSES beside the files, because the whole point of writing this directory is that
 * the tester captures the same views the gate will pair against: a reference that did not arrive
 * is a view the agent should still capture (under that name) rather than one that does not exist.
 *
 * The "on disk" sentence is bound to the files that ARE on disk, and appears only with them. A
 * block that asserts a populated directory when the pass wrote nothing (every transfer failed, or
 * the directory could not be created at all) sends the agent looking for a path that may not even
 * exist, and reads as a platform bug at exactly the moment the platform is already degraded.
 */
export function referenceScreenshotGuidance(outcome: ContextImageOutcome): string {
  if (!outcome.written.length && !outcome.missing.length) return ''
  const onDisk = outcome.written.length
    ? `\n\nThese are on disk, one file per view:\n${outcome.written
        .map((file) => `- \`${outcome.dir}/${file.fileName}\`: ${file.view}`)
        .join('\n')}`
    : ''
  const absent = outcome.missing.length
    ? `\n\nThese views have NO reference image in this container, for the reason given. Capture them
anyway, under exactly these names. There is simply nothing here to compare against:\n${outcome.missing
        .map((file) => `- ${file.view}: NOT on disk (${file.reason})`)
        .join('\n')}`
    : ''
  return `

## Reference designs (capture these views)
Capture the views named below and name each screenshot's \`view\` EXACTLY as given, so the platform
can pair your capture with its reference. Capture any other view the task needs under a name of
your own.${onDisk}${absent}`
}

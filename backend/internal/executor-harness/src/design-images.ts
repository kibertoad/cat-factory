import type { ImageManifestSpec } from './job.js'
import type { Logger } from './logger.js'
import { CONTEXT_DIR } from './pi.js'
import { type ContextImageOutcome, materializeContextImages } from './context-images.js'

// ---------------------------------------------------------------------------
// DESIGN PICTURES on disk for a BUILDING kind: what the screen is supposed to look like, in
// `.cat-context/design-renders/`, for an agent CLI that can read an image into its turn.
//
// The other use of the same artifacts the capture path delivers, and the reason each has its own
// directory: a tester reading these six would take them for the complete list of views to capture,
// and a builder reading the tester's twenty-four would spend its context on screens it was never
// asked to touch.
//
// The agent is told about these files by the BACKEND's prompt, which is the half that knows which
// views the platform holds and whether this model can be shown them at all. What this module adds
// is the container's own half of the truth: which of those files actually landed here.
// ---------------------------------------------------------------------------

/** Subdirectory of {@link CONTEXT_DIR} the design pictures are written to. */
export const DESIGN_RENDER_SUBDIR = 'design-renders'

/** The relative directory the design pictures are written to (what the prompt names). */
export const DESIGN_RENDER_DIR = `${CONTEXT_DIR}/${DESIGN_RENDER_SUBDIR}`

/** Download this job's design pictures. See {@link materializeContextImages}. */
export function materializeDesignImages(
  cwd: string,
  spec: ImageManifestSpec,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ContextImageOutcome> {
  return materializeContextImages(cwd, DESIGN_RENDER_SUBDIR, spec, options)
}

/**
 * Download the design pictures and answer the CORRECTION to the prompt's own list, or '' when
 * everything the backend named is on disk.
 *
 * Silence on success is the difference from the capture delivery, and it is deliberate. The
 * backend's prompt already names every picture and its view, because it is the side that knows
 * which views exist and how they were delivered; repeating the list here would give the agent two
 * lists of the same files, differing only when something went wrong, with nothing saying which one
 * is current.
 *
 * So this speaks only when the container's truth DIVERGES from what the prompt promised. That
 * divergence has to be stated: an agent told to open a file that is not there re-reads the path,
 * lists the directory and eventually decides the design is missing something, when the honest
 * answer is that this one picture did not transfer and the rest are exactly as described.
 */
export async function deliverDesignImages(
  cwd: string,
  spec: ImageManifestSpec | undefined,
  options: { signal?: AbortSignal; log: Logger; fetchImpl?: typeof fetch },
): Promise<string> {
  if (!spec) return ''
  const outcome = await materializeDesignImages(cwd, spec, options)
  if (outcome.missing.length) {
    options.log.warn('agent: some design pictures are not on disk', {
      written: outcome.written.length,
      missing: outcome.missing.length,
      reasons: outcome.missing.map((file) => file.reason).slice(0, 5),
    })
  }
  return designImageGuidance(outcome)
}

/**
 * The prompt correction: the views whose picture is NOT in this container, with the cause.
 *
 * Empty whenever the transfer matched the prompt, including the case where the manifest was empty
 * to begin with. The agent is told to carry on from the textual design description rather than to
 * ask for the file, because nothing in the run can deliver it after this point.
 */
export function designImageGuidance(outcome: ContextImageOutcome): string {
  if (!outcome.missing.length) return ''
  return `

## Design pictures: correction
These views were listed above as pictures, and are NOT in this container. Work from the textual
design description for them; there is nothing to open and nothing that can fetch them now:
${outcome.missing.map((file) => `- ${file.view}: NOT on disk (${file.reason})`).join('\n')}`
}

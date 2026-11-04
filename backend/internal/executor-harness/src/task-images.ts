import type { ImageManifestSpec } from './job.js'
import type { Logger } from './logger.js'
import { CONTEXT_DIR } from './pi.js'
import { type ContextImageOutcome, materializeContextImages } from './context-images.js'

// ---------------------------------------------------------------------------
// The images a person ATTACHED to the task to explain it (a bug screenshot, a sketch), on disk in
// `.cat-context/task-images/` for an agent CLI that can read an image into its turn.
//
// Its own directory rather than the design renders' one: those are the screen to build, these
// explain the task, and an agent reading one set as the other is misled either way. Like the design
// pictures, the BACKEND's prompt names every file; this module only corrects that list when a file
// did not land.
// ---------------------------------------------------------------------------

/** Subdirectory of {@link CONTEXT_DIR} the attached images are written to. */
export const TASK_IMAGE_SUBDIR = 'task-images'

/** The relative directory the attached images are written to (what the prompt names). */
export const TASK_IMAGE_DIR = `${CONTEXT_DIR}/${TASK_IMAGE_SUBDIR}`

/**
 * Download the attached images and answer the CORRECTION to the prompt's own list, or '' when
 * everything the backend named is on disk. Silent on success for the reason the design delivery
 * is: a second list of the same files would leave the agent unsure which one is current.
 */
export async function deliverTaskImages(
  cwd: string,
  spec: ImageManifestSpec | undefined,
  options: { signal?: AbortSignal; log: Logger; fetchImpl?: typeof fetch },
): Promise<string> {
  if (!spec) return ''
  const outcome = await materializeContextImages(cwd, TASK_IMAGE_SUBDIR, spec, options)
  if (outcome.missing.length) {
    options.log.warn('agent: some attached task images are not on disk', {
      written: outcome.written.length,
      missing: outcome.missing.length,
      reasons: outcome.missing.map((file) => file.reason).slice(0, 5),
    })
  }
  return taskImageGuidance(outcome)
}

/** The prompt correction: the attached images that are NOT in this container, with the cause. */
export function taskImageGuidance(outcome: ContextImageOutcome): string {
  if (!outcome.missing.length) return ''
  return `

## Images attached to this task: correction
These images were listed above as files, and are NOT in this container. Work from the task's
description for them; there is nothing to open and nothing that can fetch them now:
${outcome.missing.map((file) => `- ${file.view}: NOT on disk (${file.reason})`).join('\n')}`
}

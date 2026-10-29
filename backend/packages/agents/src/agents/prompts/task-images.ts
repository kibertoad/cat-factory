import type { AgentRunContext, DesignImageDelivery, DesignImageSet } from '@cat-factory/kernel'
import { CONTEXT_DIR, DESIGN_IMAGE_REFUSALS } from './standard.js'

/**
 * Subdirectory of {@link CONTEXT_DIR} holding the images a person attached to the task, for a
 * container agent whose CLI opens image files.
 *
 * Its own directory rather than the design renders' one: these explain the TASK, where a design
 * render is the screen to build, and an agent reading one set as the other is misled either way.
 * Written by the harness, which depends on no workspace package, so the constant exists twice and
 * the copies are pinned byte-for-byte by the harness contract suite.
 */
export const TASK_IMAGE_DIR = `${CONTEXT_DIR}/task-images`

/**
 * The images attached to this task, and what became of them.
 *
 * Every outcome is stated: shown as files, shown in the message, or withheld with its cause. An
 * agent told nothing reads the description as the whole task, which is wrong in exactly the cases
 * where the author attached a picture because words were not enough.
 *
 * Empty (so the prompt is byte-identical) for a task with no attached image.
 */
export function taskImagesSection(
  context: Pick<AgentRunContext, 'taskImages' | 'taskImageDelivery'>,
): string {
  return renderTaskImages(context.taskImages, context.taskImageDelivery)
}

/**
 * The rendering half of {@link taskImagesSection}, taking the set and the verdict directly, for an
 * inline service that assembles its own prompt rather than an {@link AgentRunContext}.
 */
export function renderTaskImages(
  set: DesignImageSet | undefined,
  delivery: DesignImageDelivery | undefined,
): string {
  if (!set?.files.length || !delivery) return ''
  const names = set.files.map((file) =>
    delivery.attached && delivery.channel === 'files'
      ? `- \`${TASK_IMAGE_DIR}/${file.fileName}\`: ${file.view}`
      : `- ${file.view}`,
  )
  const lead = delivery.attached
    ? delivery.channel === 'files'
      ? [
          'The author of this task attached images to explain it, one file per image under',
          `\`${TASK_IMAGE_DIR}/\`. Open them before you start: they are part of the task as much`,
          'as its description is.',
        ]
      : [
          'The author of this task attached images to explain it. They are attached to this',
          'message, in the order listed below. Look at them before you start: they are part of the',
          'task as much as its description is.',
        ]
    : [
        'The author of this task attached images the platform could NOT put in front of you:',
        `${DESIGN_IMAGE_REFUSALS[delivery.reason]}.`,
        'Work from the description. Do not ask for the images and do not try to fetch them;',
        'nothing in this run can deliver them to you.',
      ]
  const omitted = set.omitted.length
    ? ['', `Not included, and nothing in this run can add them: ${set.omitted.join(', ')}.`]
    : []
  return `\n\n## Images attached to this task\n${lead.join('\n')}\n\n${names.join('\n')}${omitted.join('\n')}`
}

import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { userPromptFor } from '../catalog.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { TASK_IMAGE_DIR, taskImagesSection } from './task-images.js'

const SET = {
  files: [
    { view: 'crash.png', artifactId: 'art_1', contentType: 'image/png', fileName: 'crash-png.png' },
  ],
  omitted: ['whiteboard.jpg'],
}

function context(over: Partial<AgentRunContext>): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'build',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'Fix the crash', type: 'service', description: 'It crashes on save' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as unknown as AgentRunContext
}

describe('taskImagesSection', () => {
  it('says nothing for a task with no attached image', () => {
    expect(taskImagesSection({})).toBe('')
  })

  it('names each file under the task-images directory when a container CLI can open them', () => {
    const section = taskImagesSection({
      taskImages: SET,
      taskImageDelivery: { attached: true, channel: 'files' },
    })
    expect(section).toContain(`\`${TASK_IMAGE_DIR}/crash-png.png\`: crash.png`)
    expect(section).toContain('Not included, and nothing in this run can add them: whiteboard.jpg')
  })

  it('points at the message when the images ride in it', () => {
    const section = taskImagesSection({
      taskImages: SET,
      taskImageDelivery: { attached: true, channel: 'message' },
    })
    expect(section).toContain('attached to this')
    expect(section).not.toContain(TASK_IMAGE_DIR)
  })

  it('states the cause when they were withheld', () => {
    const section = taskImagesSection({
      taskImages: SET,
      taskImageDelivery: { attached: false, reason: 'harness_no_image_input' },
    })
    expect(section).toContain('could NOT put in front of you')
    expect(section).toContain('agent CLI')
    expect(section).toContain('crash.png')
  })
})

describe('userPromptFor', () => {
  // The section is appended once, centrally, so a standard phase and a registered kind that writes
  // its own prompt both state the attached images.
  it('states the attached images for a standard kind and for a self-authored one', () => {
    const registry = defaultAgentKindRegistry()
    const withImages = {
      taskImages: SET,
      taskImageDelivery: { attached: false, reason: 'model_no_image_input' } as const,
    }
    for (const agentKind of ['coder', 'spec-writer']) {
      const prompt = userPromptFor(context({ agentKind, ...withImages }), registry)
      expect(prompt, agentKind).toContain('## Images attached to this task')
    }
  })
})

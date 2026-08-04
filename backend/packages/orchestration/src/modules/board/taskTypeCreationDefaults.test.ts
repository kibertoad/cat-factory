import { afterEach, describe, expect, it } from 'vitest'
import type { RecordedLogLine } from '@cat-factory/kernel'
import { createRecordingLogger, defaultTaskTypeRegistry } from '@cat-factory/kernel'
import {
  clearRegisteredTaskTypeDefaultFragments,
  DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
} from '@cat-factory/prompt-fragments'
import { createTaskTypeCreationDefaults } from './taskTypeCreationDefaults.js'

// The precedence rules `BoardService.addTask` delegates here, pinned directly rather than only
// through the service. `BoardService.fragmentIds.test.ts` covers the same rules end to end; these
// cover the branches a service-level test cannot reach cheaply.
describe('taskTypeCreationDefaults', () => {
  afterEach(() => clearRegisteredTaskTypeDefaultFragments())

  function build(register?: Parameters<ReturnType<typeof defaultTaskTypeRegistry>['register']>[0]) {
    const lines: RecordedLogLine[] = []
    const taskTypeRegistry = defaultTaskTypeRegistry()
    if (register) taskTypeRegistry.register(register)
    return {
      lines,
      defaults: createTaskTypeCreationDefaults({
        taskTypeRegistry,
        logger: createRecordingLogger(lines),
      }),
    }
  }

  const OPERATION = {
    taskType: 'org:introduce-api',
    presentation: {
      label: 'Introduce API',
      icon: 'i-lucide-plug',
      color: '#0ea5e9',
      description: 'Expose functionality over HTTP.',
    },
    defaultFragmentIds: ['org.api-guidelines'],
  }

  it('honours an EMPTY explicit list as "the user cleared the inherited picks"', () => {
    // The distinction an `??` chain exists for: an empty array is a choice, absence is not.
    const { defaults } = build()
    expect(
      defaults.fragmentIdsFor({
        taskType: 'feature',
        explicit: [],
        serviceFragmentIds: ['node.best-practices'],
      }),
    ).toEqual([])
  })

  it('inherits the service standards when the form sent no list', () => {
    const { defaults } = build()
    expect(
      defaults.fragmentIdsFor({ taskType: 'feature', serviceFragmentIds: ['node.best-practices'] }),
    ).toEqual(['node.best-practices'])
  })

  it('always adds the per-type defaults, even over a cleared list', () => {
    // A document task cannot lose its writing-style set by clearing the picker.
    const { defaults } = build()
    expect(defaults.fragmentIdsFor({ taskType: 'document', explicit: [] })).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
    ])
  })

  it("adds a registered operation's standing context, deduped and last", () => {
    const { defaults, lines } = build(OPERATION)
    expect(
      defaults.fragmentIdsFor({
        taskType: 'org:introduce-api',
        explicit: ['org.api-guidelines', 'react.hooks'],
      }),
    ).toEqual(['org.api-guidelines', 'react.hooks'])
    expect(lines).toEqual([])
  })

  it('WARNS on a namespaced type this process does not register', () => {
    const { defaults, lines } = build()
    expect(defaults.fragmentIdsFor({ taskType: 'org:introduce-api' })).toEqual([])
    expect(lines.map((line) => line.level)).toEqual(['warn'])
    expect(lines[0]?.fields?.taskType).toBe('org:introduce-api')
  })

  it('resolves the pipeline pin from the registered descriptor', () => {
    const { defaults } = build({ ...OPERATION, defaultPipelineId: 'pl_org_introduce_api' })
    expect(defaults.pipelineIdFor('org:introduce-api')).toBe('pl_org_introduce_api')
    // A built-in type keeps its own mapping, and an unmapped one falls through to the picker.
    expect(defaults.pipelineIdFor('document')).toBeTruthy()
    expect(defaults.pipelineIdFor('feature')).toBeUndefined()
  })
})

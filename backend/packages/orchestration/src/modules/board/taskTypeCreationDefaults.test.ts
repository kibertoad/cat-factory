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

  // D8: the collected bag is checked against the descriptor at CREATION, so the form's `required`
  // markers and option lists are the contract rather than client-side decoration.
  describe('validatedFields', () => {
    const FORM = {
      ...OPERATION,
      fields: [
        { key: 'entity', label: 'Entity', type: 'text' as const, required: true, maxLength: 10 },
        {
          key: 'style',
          label: 'Style',
          type: 'select' as const,
          options: [{ value: 'action', label: 'Action' }],
        },
        {
          key: 'verb',
          label: 'Verb',
          type: 'text' as const,
          showWhen: { key: 'style', equals: 'action' },
        },
      ],
    }

    it('accepts a filled form and freezes only the declared, visible answers', () => {
      const { defaults } = build(FORM)
      expect(
        defaults.validatedFields('org:introduce-api', {
          custom: { entity: 'Order', style: 'action', verb: 'refund' },
        }),
      ).toEqual({ custom: { entity: 'Order', style: 'action', verb: 'refund' } })
      // A hidden field's stale answer is dropped rather than frozen unvalidated.
      expect(
        defaults.validatedFields('org:introduce-api', { custom: { entity: 'Order', verb: 'x' } }),
      ).toEqual({ custom: { entity: 'Order' } })
    })

    it('refuses a bag that contradicts the descriptor, naming every problem', () => {
      const { defaults } = build(FORM)
      const call = () =>
        defaults.validatedFields('org:introduce-api', {
          custom: { style: 'archive', bogus: 'x' },
        })
      expect(call).toThrow(/task type 'org:introduce-api'/)
      // The machine-readable half: a reason plus the problems list, for the SPA to render.
      try {
        call()
      } catch (error) {
        const details = (error as { details?: { reason?: string; problems?: string[] } }).details
        expect(details?.reason).toBe('task_type_fields_invalid')
        expect(details?.problems).toEqual([
          'Unknown field "bogus".',
          'Field "entity" is required.',
          'Field "style" has a value outside its options.',
        ])
      }
    })

    it('drops the key entirely when every answer sanitizes away', () => {
      // `custom` present must keep meaning "parameters were collected", which is what the
      // dispatch-time projection reads it as.
      const { defaults } = build({ ...FORM, fields: [FORM.fields[1]!] })
      expect(defaults.validatedFields('org:introduce-api', { custom: {} })).toBeUndefined()
      expect(
        defaults.validatedFields('org:introduce-api', { severity: 'high', custom: {} }),
      ).toEqual({ severity: 'high' })
    })

    it('passes through what it cannot or must not check', () => {
      // A built-in type (schema-typed top-level fields), a type this process does not register (a
      // supported row: task types are node-local), and a bespoke form panel that owns its own bag.
      const { defaults } = build({ ...OPERATION, formPanel: 'org:api-form' })
      expect(defaults.validatedFields('bug', { severity: 'high' })).toEqual({ severity: 'high' })
      expect(
        defaults.validatedFields('org:introduce-api', { custom: { anything: 'goes' } }),
      ).toEqual({ custom: { anything: 'goes' } })
      const unregistered = build().defaults
      expect(
        unregistered.validatedFields('org:unknown-op', { custom: { anything: 'goes' } }),
      ).toEqual({ custom: { anything: 'goes' } })
      expect(defaults.validatedFields('feature', undefined)).toBeUndefined()
    })
  })

  it('resolves the pipeline pin from the registered descriptor', () => {
    const { defaults } = build({ ...OPERATION, defaultPipelineId: 'pl_org_introduce_api' })
    expect(defaults.pipelineIdFor('org:introduce-api')).toBe('pl_org_introduce_api')
    // A built-in type keeps its own mapping, and an unmapped one falls through to the picker.
    expect(defaults.pipelineIdFor('document')).toBeTruthy()
    expect(defaults.pipelineIdFor('feature')).toBeUndefined()
  })
})

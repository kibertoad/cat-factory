import { describe, expect, it } from 'vitest'
import type { RecordedLogLine } from '@cat-factory/kernel'
import {
  createRecordingLogger,
  defaultTaskTypeRegistry,
  registryPromptFragmentSource,
} from '@cat-factory/kernel'
import {
  DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
  promptFragmentRegistryWithBuiltins,
} from '@cat-factory/prompt-fragments'
import { createTaskTypeCreationDefaults } from './taskTypeCreationDefaults.js'

// The precedence rules `BoardService.addTask` delegates here, pinned directly rather than only
// through the service. `BoardService.fragmentIds.test.ts` covers the same rules end to end; these
// cover the branches a service-level test cannot reach cheaply.
describe('taskTypeCreationDefaults', () => {
  function build(
    register?: Parameters<ReturnType<typeof defaultTaskTypeRegistry>['register']>[0],
    suppressed: string[] = [],
  ) {
    const lines: RecordedLogLine[] = []
    const taskTypeRegistry = defaultTaskTypeRegistry()
    if (register) taskTypeRegistry.register(register)
    return {
      lines,
      defaults: createTaskTypeCreationDefaults({
        taskTypeRegistry,
        // A fresh registry per build, carrying the shipped per-type defaults.
        promptFragmentSource: registryPromptFragmentSource(promptFragmentRegistryWithBuiltins()),
        taskTypeSuppressionRepository: {
          list: async () => suppressed,
          suppress: async () => {},
          restore: async () => {},
        },
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

  it('honours an EMPTY explicit list as "the user cleared the inherited picks"', async () => {
    // The distinction an `??` chain exists for: an empty array is a choice, absence is not.
    const { defaults } = build()
    expect(
      await defaults.fragmentIdsFor({
        taskType: 'feature',
        explicit: [],
        serviceFragmentIds: ['node.best-practices'],
      }),
    ).toEqual([])
  })

  it('inherits the service standards when the form sent no list', async () => {
    const { defaults } = build()
    expect(
      await defaults.fragmentIdsFor({
        taskType: 'feature',
        serviceFragmentIds: ['node.best-practices'],
      }),
    ).toEqual(['node.best-practices'])
  })

  it('always adds the per-type defaults, even over a cleared list', async () => {
    // A document task cannot lose its writing-style set by clearing the picker.
    const { defaults } = build()
    expect(await defaults.fragmentIdsFor({ taskType: 'document', explicit: [] })).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
    ])
  })

  it("adds a registered operation's standing context, deduped and last", async () => {
    const { defaults, lines } = build(OPERATION)
    expect(
      await defaults.fragmentIdsFor({
        taskType: 'org:introduce-api',
        explicit: ['org.api-guidelines', 'react.hooks'],
      }),
    ).toEqual(['org.api-guidelines', 'react.hooks'])
    expect(lines).toEqual([])
  })

  it('WARNS on a namespaced type this process does not register', async () => {
    const { defaults, lines } = build()
    expect(await defaults.fragmentIdsFor({ taskType: 'org:introduce-api' })).toEqual([])
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

    it('refuses an ABSENT bag exactly as it refuses an empty one', () => {
      // The two spellings of "nothing was collected" must refuse alike, or the check is opt-in: a
      // headless caller would satisfy an operation's declared form by omitting `taskTypeFields`
      // altogether, which is the door it exists to close. The SPA never gets here (its submit
      // button mirrors the same rule), so this case is reachable only from the API.
      const { defaults } = build(FORM)
      const required = /Field "entity" is required/
      expect(() => defaults.validatedFields('org:introduce-api', undefined)).toThrow(required)
      expect(() => defaults.validatedFields('org:introduce-api', {})).toThrow(required)
      expect(() => defaults.validatedFields('org:introduce-api', { custom: {} })).toThrow(required)
      // A top-level built-in key on a custom type is not an answer to its form either.
      expect(() => defaults.validatedFields('org:introduce-api', { severity: 'high' })).toThrow(
        required,
      )
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

  describe('descriptor defaults at the creation door', () => {
    const WITH_DEFAULT = {
      ...OPERATION,
      fields: [
        { key: 'entity', label: 'Entity', type: 'text' as const, required: true },
        {
          key: 'auth',
          label: 'Auth',
          type: 'select' as const,
          required: true,
          default: 'service',
          options: [
            { value: 'service', label: 'Service token' },
            { value: 'user', label: 'User token' },
          ],
        },
      ],
    }

    it('answers a required-and-defaulted field the caller omitted', () => {
      // The gap this closed: the SPA seeded `auth` before submitting, so only a headless caller
      // ever saw the refusal, for a value the deployment had already declared.
      const { defaults } = build(WITH_DEFAULT)
      expect(
        defaults.validatedFields('org:introduce-api', { custom: { entity: 'Order' } }),
      ).toEqual({ custom: { entity: 'Order', auth: 'service' } })
    })

    it('never overrides a value the caller did send', () => {
      const { defaults } = build(WITH_DEFAULT)
      expect(
        defaults.validatedFields('org:introduce-api', {
          custom: { entity: 'Order', auth: 'user' },
        }),
      ).toEqual({ custom: { entity: 'Order', auth: 'user' } })
    })

    it('still refuses a required field that has NO default', () => {
      const { defaults } = build(WITH_DEFAULT)
      expect(() =>
        defaults.validatedFields('org:introduce-api', { custom: { auth: 'user' } }),
      ).toThrow(/entity/)
    })
  })

  describe('suppression', () => {
    it('refuses a task of an operation this workspace hid', async () => {
      const { defaults } = build(OPERATION, ['org:introduce-api'])
      await expect(defaults.assertNotSuppressed('ws1', 'org:introduce-api')).rejects.toThrow(
        /not offered on this board/,
      )
    })

    it('allows an operation this workspace did not hide, and every built-in type', async () => {
      const { defaults } = build(OPERATION, ['org:other-op'])
      await expect(
        defaults.assertNotSuppressed('ws1', 'org:introduce-api'),
      ).resolves.toBeUndefined()
      // A built-in short-circuits without a query at all: built-ins are not suppressible, so every
      // ordinary `feature` creation would otherwise pay a read to learn nothing.
      await expect(defaults.assertNotSuppressed('ws1', 'feature')).resolves.toBeUndefined()
    })

    it('passes everything through when no suppression store is wired', async () => {
      const defaults = createTaskTypeCreationDefaults({
        taskTypeRegistry: defaultTaskTypeRegistry(),
        logger: createRecordingLogger([]),
      })
      await expect(
        defaults.assertNotSuppressed('ws1', 'org:introduce-api'),
      ).resolves.toBeUndefined()
    })

    it('PROPAGATES an unreadable store rather than creating the task anyway', async () => {
      // The half of the split posture that lives at this door, and the one worth a test: the
      // snapshot's read of the same rows degrades to \"nothing suppressed\" on purpose
      // (`TaskTypeSuppressionService.test.ts`), because it renders a picker. This one decides
      // whether a ROW IS WRITTEN, and it hits the same database the insert on the next line goes
      // to, so there is no outage to ride out: swallowing here creates the task the workspace
      // asked not to have and reports nothing.
      const defaults = createTaskTypeCreationDefaults({
        taskTypeRegistry: defaultTaskTypeRegistry(),
        taskTypeSuppressionRepository: {
          list: async () => {
            throw new Error('store unreachable')
          },
          suppress: async () => {},
          restore: async () => {},
        },
        logger: createRecordingLogger([]),
      })
      await expect(defaults.assertNotSuppressed('ws1', 'org:introduce-api')).rejects.toThrow(
        /store unreachable/,
      )
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

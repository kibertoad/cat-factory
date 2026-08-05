import { describe, expect, it } from 'vitest'
import { defaultTaskTypeRegistry } from '@cat-factory/kernel'
import type { TaskTypeRegistry } from '@cat-factory/kernel'
import { publicTaskTypeCatalog, resolveTaskTypeFields } from './taskTypeFields.js'

// The public surface's two halves over ONE table: what the catalog advertises, and what creation
// then accepts. Every assertion here is really about those two agreeing.

const OPERATION = {
  taskType: 'org:introduce-api',
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
    category: 'API delivery',
  },
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
  defaultPipelineId: 'pl_org_introduce_api',
}

function registryWith(...types: Parameters<TaskTypeRegistry['register']>[0][]): TaskTypeRegistry {
  const registry = defaultTaskTypeRegistry()
  for (const type of types) registry.register(type)
  return registry
}

describe('publicTaskTypeCatalog', () => {
  it('serves the built-ins plus the registered operations, and omits what the board hides', () => {
    const registry = registryWith(OPERATION, {
      ...OPERATION,
      taskType: 'org:hidden',
      presentation: { ...OPERATION.presentation, label: 'Hidden' },
    })
    const catalog = publicTaskTypeCatalog(registry, new Set(['org:hidden']))
    const ids = catalog.map((entry) => entry.taskType)
    expect(ids).toContain('bug')
    expect(ids).toContain('org:introduce-api')
    // Absent because the endpoint answers "what may I create HERE": listing a type whose creation
    // is then refused misleads the very client that read the catalog to find out.
    expect(ids).not.toContain('org:hidden')
    // Built-ins first, so a client reading top-down sees the ordinary choices before the org's.
    expect(catalog.findIndex((e) => e.taskType === 'bug')).toBeLessThan(
      catalog.findIndex((e) => e.taskType === 'org:introduce-api'),
    )
  })

  it('projects a registered operation’s presentation, form and pipeline pin', () => {
    const entry = publicTaskTypeCatalog(registryWith(OPERATION), new Set()).find(
      (e) => e.taskType === 'org:introduce-api',
    )!
    expect(entry.builtin).toBe(false)
    expect(entry.label).toBe('Introduce API')
    expect(entry.category).toBe('API delivery')
    expect(entry.defaultPipelineId).toBe('pl_org_introduce_api')
    expect(entry.fields.map((f) => f.key)).toEqual(['entity', 'auth'])
  })

  it('never projects formPanel, which names a component no external client can render', () => {
    const entry = publicTaskTypeCatalog(
      registryWith({ ...OPERATION, formPanel: 'org:introduce-api-form' }),
      new Set(),
    ).find((e) => e.taskType === 'org:introduce-api')!
    expect(entry).not.toHaveProperty('formPanel')
    // The declared fields still ship: they are what this API validates, whatever the app renders.
    expect(entry.fields.map((f) => f.key)).toEqual(['entity', 'auth'])
  })

  it('serves the built-in kinds even with no registry wired at all', () => {
    const ids = publicTaskTypeCatalog(undefined, new Set()).map((e) => e.taskType)
    expect(ids).toContain('feature')
    expect(ids).toContain('bug')
  })
})

describe('resolveTaskTypeFields', () => {
  const registry = registryWith(OPERATION)
  const create = (body: Parameters<typeof resolveTaskTypeFields>[0]) =>
    resolveTaskTypeFields(body, registry)

  it('lands a custom type’s values in the sparse `custom` bag, defaults folded in', () => {
    expect(
      create({ title: 't', taskType: 'org:introduce-api', fields: { entity: 'Order' } }),
    ).toEqual({ custom: { entity: 'Order', auth: 'service' } })
  })

  it('lands a BUILT-IN type’s values on the schema-typed top-level keys instead', () => {
    // The asymmetry the mapper exists for: the existing creation machinery (the review task's PR
    // resolution, the document fields) reads these keys, so it runs unchanged.
    expect(create({ title: 't', taskType: 'bug', fields: { severity: 'critical' } })).toEqual({
      severity: 'critical',
    })
    expect(create({ title: 't', taskType: 'review', fields: { prNumber: 12 } })).toEqual({
      prNumber: 12,
    })
  })

  it('refuses a bag the descriptor contradicts, naming every problem at once', () => {
    // One round trip per field, against a form the caller cannot see, is the experience this
    // surface exists to avoid.
    let thrown: unknown
    try {
      create({ title: 't', taskType: 'org:introduce-api', fields: { auth: 'root', bogus: 'x' } })
    } catch (error) {
      thrown = error
    }
    const details = (thrown as { details?: { reason?: string; problems?: string[] } }).details
    expect(details?.reason).toBe('task_type_fields_invalid')
    expect(details?.problems?.length).toBeGreaterThanOrEqual(3) // unknown key, bad option, missing entity
  })

  it('refuses a built-in type’s value outside its declared options', () => {
    expect(() =>
      create({ title: 't', taskType: 'bug', fields: { severity: 'apocalyptic' } }),
    ).toThrow(/severity/)
  })

  it('carries an UNREGISTERED namespaced type’s values through unchecked', () => {
    // Task types are node-local by design, so a process whose package predates a registration is a
    // supported state; there is nothing to validate against, and dropping the caller's brief in
    // silence is the worse of the two failures.
    expect(create({ title: 't', taskType: 'org:not-here', fields: { anything: 'goes' } })).toEqual({
      custom: { anything: 'goes' },
    })
  })

  it('carries a formPanel type’s bag through, its bespoke form owning the semantics', () => {
    const panelled = registryWith({ ...OPERATION, formPanel: 'org:introduce-api-form' })
    expect(
      resolveTaskTypeFields(
        { title: 't', taskType: 'org:introduce-api', fields: { whatever: 'x' } },
        panelled,
      ),
    ).toEqual({ custom: { whatever: 'x' } })
  })

  it('returns undefined when there is nothing to carry, so no empty bag reaches the row', () => {
    // `custom`'s PRESENCE is what the dispatch-time projection reads as "parameters were
    // collected", so an empty object would announce a brief that does not exist.
    expect(create({ title: 't' })).toBeUndefined()
    expect(create({ title: 't', taskType: 'feature', fields: {} })).toBeUndefined()
  })
})

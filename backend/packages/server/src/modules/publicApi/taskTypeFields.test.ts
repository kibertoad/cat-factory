import { describe, expect, it } from 'vitest'
import { defaultTaskTypeRegistry } from '@cat-factory/kernel'
import type { Block, TaskTypeRegistry } from '@cat-factory/kernel'
import {
  publicTaskTypeCatalog,
  resolveTaskTypeFields,
  resolveTaskTypeFieldsPatch,
} from './taskTypeFields.js'

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

  it('never projects formPanel, nor the fields such a type declares but nothing checks', () => {
    const panelled = registryWith({ ...OPERATION, formPanel: 'org:introduce-api-form' })
    const projected = publicTaskTypeCatalog(panelled, new Set()).find(
      (e) => e.taskType === 'org:introduce-api',
    )!
    expect(projected).not.toHaveProperty('formPanel')
    // `fields` on a catalog entry means ONE thing: what creation checks a bag against. A
    // `formPanel` type's bag is checked by nothing (`resolveTaskTypeFields` carries it through
    // verbatim, and the internal door's `checkCustomFields` does the same), so projecting its
    // descriptors would advertise a contract that does not exist. The two halves are asserted
    // together on purpose: this is the pair that must agree.
    expect(projected.fields).toEqual([])
    expect(
      resolveTaskTypeFields(
        { title: 't', taskType: 'org:introduce-api', fields: { undeclared: 'x' } },
        panelled,
      ),
    ).toEqual({ custom: { undeclared: 'x' } })
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

  it('refuses a built-in value the DESCRIPTOR admits and the internal schema does not', () => {
    // `prNumber` is `v.integer()` on `taskTypeFieldsSchema` and a plain `number` descriptor here,
    // because the descriptor vocabulary has no integer flag. The restatement cannot carry the
    // rule, so the built-in branch parses through the schema instead of casting to it: before
    // that, `3.7` passed the public surface and landed on the block as the PR to review.
    expect(() =>
      resolveTaskTypeFields(
        { title: 't', taskType: 'review', fields: { prNumber: 3.7 } },
        undefined,
      ),
    ).toThrow(/prNumber/)
    expect(
      resolveTaskTypeFields({ title: 't', taskType: 'review', fields: { prNumber: 4 } }, undefined),
    ).toEqual({ prNumber: 4 })
  })

  it('returns undefined when there is nothing to carry, so no empty bag reaches the row', () => {
    // `custom`'s PRESENCE is what the dispatch-time projection reads as "parameters were
    // collected", so an empty object would announce a brief that does not exist.
    expect(create({ title: 't' })).toBeUndefined()
    expect(create({ title: 't', taskType: 'feature', fields: {} })).toBeUndefined()
  })
})

// The PATCH counterpart. Its whole difference from creation is that a caller sends a FRAGMENT of
// the bag, because this API never serves the bag back — so these are all really about the merge.
describe('resolveTaskTypeFieldsPatch', () => {
  const registry = registryWith(OPERATION)
  const task = (extra: Partial<Block> = {}): Block =>
    ({
      id: 'blk_1',
      title: 'Task',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: 'frame_svc',
      ...extra,
    }) as Block

  it('writes the keys sent and leaves every other stored value alone', () => {
    const patch = resolveTaskTypeFieldsPatch(
      task({
        taskType: 'org:introduce-api',
        taskTypeFields: { custom: { entity: 'Order', auth: 'user' } },
      }),
      { entity: 'Invoice' },
      registry,
    )
    expect(patch).toEqual({ customTaskTypeFields: { entity: 'Invoice', auth: 'user' } })
  })

  it('validates the MERGED bag, so a required field already answered need not be restated', () => {
    // Validating the fragment alone would refuse every partial patch of a type declaring a
    // required field, which is most of the operations this exists to repair.
    expect(() =>
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'org:introduce-api', taskTypeFields: { custom: { entity: 'Order' } } }),
        { auth: 'user' },
        registry,
      ),
    ).not.toThrow()
    // ...and one that is NOT answered anywhere is still refused, naming it.
    expect(() =>
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'org:introduce-api' }),
        { auth: 'user' },
        registry,
      ),
    ).toThrow(/entity/)
  })

  it('fills a bug’s missing reproduction steps, the gate’s most expensive gap', () => {
    // `reproduction_missing` is a BLOCKING input-gate finding naming this exact field, and until
    // the patch carried it the only headless exits were waiving the finding or deleting the task.
    expect(
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'bug', taskTypeFields: { severity: 'high' } }),
        { stepsToReproduce: '1. open export 2. click' },
        registry,
      ),
    ).toEqual({
      builtinTaskTypeFields: { severity: 'high', stepsToReproduce: '1. open export 2. click' },
    })
  })

  it('carries a built-in type’s INTERNAL-only keys through untouched', () => {
    // `targetPath` and the per-DocKind prose are deliberately absent from the public descriptors,
    // so a caller cannot name them — and a replace that dropped what it could not see would delete
    // what the app collected.
    const patch = resolveTaskTypeFieldsPatch(
      task({
        taskType: 'document',
        taskTypeFields: {
          docKind: 'adr',
          targetPath: 'docs/adr/0001-x.md',
          decisionDrivers: 'cost',
        },
      }),
      { audience: 'platform engineers' },
      registry,
    )
    expect(patch).toEqual({
      builtinTaskTypeFields: {
        docKind: 'adr',
        targetPath: 'docs/adr/0001-x.md',
        decisionDrivers: 'cost',
        audience: 'platform engineers',
      },
    })
  })

  it('never touches the other half of the bag', () => {
    // A custom bag on a built-in-typed task is unusual but storable; the point is that naming one
    // half can never clear the other.
    const patch = resolveTaskTypeFieldsPatch(
      task({ taskType: 'bug', taskTypeFields: { custom: { leftover: 'x' } } }),
      { severity: 'low' },
      registry,
    )
    expect(patch).toEqual({ builtinTaskTypeFields: { severity: 'low' } })
    expect(patch.builtinTaskTypeFields).not.toHaveProperty('custom')
  })

  it('refuses through the same door creation does, with every problem at once', () => {
    let thrown: unknown
    try {
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'org:introduce-api', taskTypeFields: { custom: { entity: 'Order' } } }),
        { auth: 'root', bogus: 'x' },
        registry,
      )
    } catch (error) {
      thrown = error
    }
    const details = (thrown as { details?: { reason?: string; problems?: string[] } }).details
    expect(details?.reason).toBe('task_type_fields_invalid')
    expect(details?.problems?.length).toBeGreaterThanOrEqual(2)
  })

  it('merges an UNREGISTERED namespaced type’s values verbatim, as creation carries them', () => {
    expect(
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'org:not-here', taskTypeFields: { custom: { a: '1', b: '2' } } }),
        { b: '3' },
        registry,
      ),
    ).toEqual({ customTaskTypeFields: { a: '1', b: '3' } })
  })

  it('repoints a review task by URL alone, without the stored number outranking it', () => {
    // `prNumber` and `prUrl` are two spellings of ONE target and `resolvePrNumber` prefers the
    // number, so merging the stored number back in beside the caller's URL would silently revert
    // the task to the pull request being replaced, and answer 200 for it.
    const patch = resolveTaskTypeFieldsPatch(
      task({ taskType: 'review', taskTypeFields: { prNumber: 7, reviewFocus: 'locking' } }),
      { prUrl: 'https://github.com/acme/app/pull/42' },
      registry,
    )
    expect(patch.builtinTaskTypeFields).toEqual({
      prUrl: 'https://github.com/acme/app/pull/42',
      reviewFocus: 'locking',
    })
    expect(patch.builtinTaskTypeFields).not.toHaveProperty('prNumber')
  })

  it('supersedes the other spelling in BOTH directions, and only for the group named', () => {
    const byNumber = resolveTaskTypeFieldsPatch(
      task({
        taskType: 'review',
        taskTypeFields: { prUrl: 'https://github.com/acme/app/pull/7', reviewFocus: 'locking' },
      }),
      { prNumber: 42 },
      registry,
    )
    expect(byNumber.builtinTaskTypeFields).toEqual({ prNumber: 42, reviewFocus: 'locking' })
    // A patch naming NEITHER spelling leaves the stored target entirely alone.
    const untouched = resolveTaskTypeFieldsPatch(
      task({ taskType: 'review', taskTypeFields: { prNumber: 7, prUrl: 'https://x/pull/7' } }),
      { reviewFocus: 'locking' },
      registry,
    )
    expect(untouched.builtinTaskTypeFields).toMatchObject({
      prNumber: 7,
      prUrl: 'https://x/pull/7',
      reviewFocus: 'locking',
    })
  })

  it('never re-judges a stored value against the NARROWER public descriptor', () => {
    // `stepsToReproduce` is 2000 in the public descriptors and 4000 in `taskTypeFieldsSchema`, so a
    // reproduction authored in the app can legitimately exceed what this surface advertises.
    // Judging it on every patch would refuse each one identically, for something the patch did not
    // do, leaving the task permanently un-repairable over the surface that exists to repair it.
    const patch = resolveTaskTypeFieldsPatch(
      task({ taskType: 'bug', taskTypeFields: { stepsToReproduce: 'x'.repeat(2500) } }),
      { severity: 'high' },
      registry,
    )
    expect(patch.builtinTaskTypeFields).toMatchObject({ severity: 'high' })
    expect(patch.builtinTaskTypeFields?.stepsToReproduce).toHaveLength(2500)
    // A value the caller DOES send is still held to the descriptor.
    expect(() =>
      resolveTaskTypeFieldsPatch(
        task({ taskType: 'bug' }),
        { stepsToReproduce: 'x'.repeat(2500) },
        registry,
      ),
    ).toThrow(/stepsToReproduce/)
  })

  it('lets a patch land beside a stored key the descriptor no longer declares', () => {
    // A node-local task type routinely outlives a registration, and the verbatim create path
    // stores whatever an unregistered one was given. Refusing the whole patch for a key the caller
    // did not name (and cannot read back) locked such a task out of every repair.
    const patch = resolveTaskTypeFieldsPatch(
      task({
        taskType: 'org:introduce-api',
        taskTypeFields: { custom: { entity: 'Order', auth: 'user', retired: 'stale' } },
      }),
      { entity: 'Invoice' },
      registry,
    )
    expect(patch).toEqual({ customTaskTypeFields: { entity: 'Invoice', auth: 'user' } })
  })
})

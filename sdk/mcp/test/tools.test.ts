import { describe, expect, it } from 'vitest'
import {
  CAT_FACTORY_OMITTED_OPERATIONS,
  CAT_FACTORY_TOOL_GROUPS,
  CAT_FACTORY_TOOLS,
} from '../src/tools.generated.ts'

// The tool table is generated, so these do not re-test the emitter's output field by field. They
// pin the properties a HOST and a MODEL depend on, which no typecheck can state: names are unique
// and stable-looking, every operation is accounted for, and no schema lies about what it accepts.

describe('the generated tool table', () => {
  it('accounts for every published operation, exposed or omitted with a reason', () => {
    // The spec has 39 operations. Two of them stream, and a tool call has no channel for that —
    // so the arithmetic here is the guard that a future endpoint cannot quietly fail to become a
    // tool: generation fails on an unclassified stream, and this fails on a changed total that
    // nobody has looked at. (38 → 39: the pre-token input gate's resolve, an ordinary
    // request/response operation, so it becomes a tool rather than an omission.)
    expect(CAT_FACTORY_TOOLS.length + CAT_FACTORY_OMITTED_OPERATIONS.length).toBe(39)
    expect(CAT_FACTORY_OMITTED_OPERATIONS.map((o) => o.operationId)).toEqual([
      'streamPublicJobEvents',
      'streamPublicTaskRun',
    ])
    for (const omitted of CAT_FACTORY_OMITTED_OPERATIONS) {
      // Every omission names the alternative. An absence with no way forward reads to a model as
      // an unsupported platform capability, which it then reports to its user as a limitation.
      expect(omitted.reason.length).toBeGreaterThan(40)
      expect(omitted.sdkCall).toMatch(/^client\./)
    }
  })

  it('gives every tool a unique, host-safe name in a known group', () => {
    const names = CAT_FACTORY_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of CAT_FACTORY_TOOLS) {
      // Hosts key their allow-lists and their UI off this name, and some restrict the character
      // set. Snake case over `[a-z0-9_]` is the intersection everything accepts.
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(Object.keys(CAT_FACTORY_TOOL_GROUPS)).toContain(tool.group)
      expect(tool.name.startsWith(`${tool.group}_`)).toBe(true)
    }
  })

  it('marks exactly the non-mutating tools read-only', () => {
    // `readOnlyHint` is what a host uses to decide whether a call needs a human's confirmation, so
    // a wrong one is a real-money agent run that nobody was asked about. The tools that spend are
    // the ones worth pinning by name.
    const spending = ['tasks_start', 'tasks_retry', 'jobs_create', 'notifications_act']
    for (const name of spending) {
      const tool = CAT_FACTORY_TOOLS.find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool!.readOnly, name).toBe(false)
    }
    for (const name of ['tasks_get', 'debug_list_runs', 'usage_get']) {
      expect(CAT_FACTORY_TOOLS.find((t) => t.name === name)!.readOnly, name).toBe(true)
    }
  })

  it('describes its inputs with path ids required and the body kept in its own namespace', () => {
    const create = CAT_FACTORY_TOOLS.find((tool) => tool.name === 'tasks_create')!
    expect(create.inputSchema.required).toEqual(['serviceId', 'body'])
    expect(create.inputSchema.additionalProperties).toBe(false)
    const body = create.inputSchema.properties.body as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    // The body schema is the spec's own, so what the model is shown and what the deployment
    // validates cannot disagree.
    expect(body.type).toBe('object')
    expect(body.required).toEqual(['title'])
    // A SUPERSET assertion, not an exact field list: `/api/v1` is additive forever, so pinning the
    // set turns every new optional field into a red test in the facade rather than a reviewed
    // change in the contracts, and the only possible fix is to retype the same list.
    expect(Object.keys(body.properties)).toEqual(
      expect.arrayContaining(['title', 'description', 'taskType']),
    )
    // The SEPARATION is what remains worth pinning exactly, and it is what this test is named for:
    // loosening the roster must not also stop the test noticing a path id leaking into the body.
    expect(Object.keys(body.properties)).not.toContain('serviceId')
  })

  it('never narrows an OPEN vocabulary to an enum', () => {
    // `taskType` is a closed set plus a documented escape hatch for a deployment's own kinds. As
    // an `enum` the tool would refuse a value the server accepts, which is the one thing a
    // generated client surface must never do.
    const create = CAT_FACTORY_TOOLS.find((tool) => tool.name === 'tasks_create')!
    const body = create.inputSchema.properties.body as {
      properties: { taskType: { enum?: unknown; type: string; description?: string } }
    }
    expect(body.properties.taskType.enum).toBeUndefined()
    expect(body.properties.taskType.type).toBe('string')
    expect(body.properties.taskType.description).toContain('feature')
  })

  it('lifts query filters to the top level beside the path ids', () => {
    const list = CAT_FACTORY_TOOLS.find((tool) => tool.name === 'debug_list_llm_calls')!
    const keys = Object.keys(list.inputSchema.properties)
    expect(keys).toContain('runId')
    expect(keys).toContain('limit')
    // A model should not have to nest a filter under `query` to use it, and the emitter fails
    // generation if a query name ever collides with a path one.
    expect(keys).not.toContain('query')
  })
})

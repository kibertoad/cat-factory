import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CAT_FACTORY_OMITTED_OPERATIONS,
  CAT_FACTORY_TOOL_GROUPS,
  CAT_FACTORY_TOOLS,
} from '../src/tools.generated.ts'

type SpecOperation = {
  operationId?: string
  responses?: Record<string, { content?: Record<string, unknown> }>
}

/** Every operation in the committed spec, the emitter's own input. */
function specOperations(): SpecOperation[] {
  const path = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url))
  const spec = JSON.parse(readFileSync(path, 'utf8')) as {
    paths: Record<string, Record<string, SpecOperation>>
  }
  return Object.values(spec.paths).flatMap((methods) => Object.values(methods))
}

/** Every `operationId` in the committed spec. */
function specOperationIds(): string[] {
  return specOperations()
    .map((operation) => operation.operationId)
    .filter((id): id is string => typeof id === 'string')
}

/**
 * The operations whose SUCCESS body is not JSON — an SSE stream or an opaque blob.
 *
 * These are exactly the ones a tool call has no shape for: its result is text or a declared
 * content block, so neither an open-ended event feed nor an arbitrary byte stream can be handed
 * back honestly. Derived from the spec rather than listed, so the assertion below states the RULE
 * ("a tool is omitted only when the protocol cannot carry its response") instead of re-pinning
 * whichever set happened to be true the day it was written — a list that goes stale silently, and
 * whose staleness reads as an oversight rather than a decision.
 */
function nonJsonOperationIds(): string[] {
  return specOperations()
    .filter((operation) =>
      Object.entries(operation.responses ?? {}).some(
        ([code, response]) =>
          /^2\d\d$/.test(code) &&
          Object.keys(response.content ?? {}).some((media) => media !== 'application/json'),
      ),
    )
    .map((operation) => operation.operationId)
    .filter((id): id is string => typeof id === 'string')
}

// The tool table is generated, so these do not re-test the emitter's output field by field. They
// pin the properties a HOST and a MODEL depend on, which no typecheck can state: names are unique
// and stable-looking, every operation is accounted for, and no schema lies about what it accepts.

/** Every `anyOf` branch list anywhere in a schema tree. */
function anyOfs(node: unknown): unknown[][] {
  if (Array.isArray(node)) return node.flatMap(anyOfs)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const here = Array.isArray(record.anyOf) ? [record.anyOf] : []
  return [...here, ...Object.values(record).flatMap(anyOfs)]
}

describe('the generated tool table', () => {
  it('accounts for every published operation, exposed or omitted with a reason', () => {
    // Derived from the spec, never a pinned total: a count would only re-assert what generation
    // already refuses (an operation with no SURFACE entry, an unclassified stream, an omission
    // naming an operation the spec dropped) at the price of an edit on every added endpoint.
    // What it does catch is the case `check:sdk` structurally cannot: that check REGENERATES and
    // diffs, so an emitter that consistently drops or double-emits an operation produces output
    // matching its own bug and passes. Partitioning the committed table against the committed
    // spec is the assertion that fails on it.
    const accounted = [
      ...CAT_FACTORY_TOOLS.map((tool) => tool.operationId),
      ...CAT_FACTORY_OMITTED_OPERATIONS.map((omitted) => omitted.operationId),
    ]
    expect(new Set(accounted).size).toBe(accounted.length)
    expect([...accounted].sort()).toEqual([...specOperationIds()].sort())
    // An omission is legitimate exactly when the protocol cannot carry the response, so the
    // expectation is derived from the spec's own media types. An operation that answers JSON and
    // is nonetheless omitted fails here, which is the case worth catching: it is a capability
    // quietly withheld from every host.
    expect(CAT_FACTORY_OMITTED_OPERATIONS.map((o) => o.operationId).sort()).toEqual(
      nonJsonOperationIds().sort(),
    )
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

  it('hints destructive only where a call cannot be taken back', () => {
    // A hint is present where the consequence is real money or a merged pull request, and ABSENT
    // everywhere else: the protocol's default for an unset hint is already the cautious one, so a
    // blanket `destructive: false` over the cheap writes would lower a host's caution on a guess.
    const irreversible = [
      'tasks_start',
      'tasks_retry',
      'jobs_create',
      'notifications_act',
      'tasks_delete',
    ]
    for (const name of irreversible) {
      const tool = CAT_FACTORY_TOOLS.find((t) => t.name === name)!
      expect(tool.hints?.destructive, name).toBe(true)
    }
    for (const tool of CAT_FACTORY_TOOLS) {
      // A read has no destructive semantics at all, which the emitter refuses to generate.
      if (tool.readOnly) expect(tool.hints, tool.name).toBeUndefined()
    }
    expect(CAT_FACTORY_TOOLS.find((t) => t.name === 'tasks_update')!.hints).toBeUndefined()
  })

  it('describes a result without asserting anything a newer deployment could break', () => {
    // An output schema is ENFORCED by the caller's own MCP client against an answer the deployment
    // has already committed to, and `/api/v1` is additive forever. So every assertion a new enum
    // member, union variant or required field could invalidate is dropped on the way out. That is
    // the same "an unknown value never raises" invariant the four SDK clients hold to.
    const describing = CAT_FACTORY_TOOLS.filter((tool) => tool.outputSchema)
    expect(describing.length).toBeGreaterThan(30)
    for (const tool of describing) {
      expect(tool.outputSchema!.type, tool.name).toBe('object')
      const json = JSON.stringify(tool.outputSchema)
      expect(json, tool.name).not.toContain('"required"')
      expect(json, tool.name).not.toContain('"enum"')
      expect(json, tool.name).not.toContain('"const"')
      // The only `anyOf` an output schema may carry is the NULLABLE pair, which admits a value the
      // deployment already sends. A union's `anyOf` is the assertion a new variant breaks outright,
      // and this surface adds decision kinds.
      for (const branches of anyOfs(tool.outputSchema)) {
        expect(branches, `${tool.name}: ${JSON.stringify(branches)}`).toHaveLength(2)
        expect(branches[1]).toEqual({ type: 'null' })
      }
    }
    // A closed vocabulary still reaches the model, as prose that no future member can invalidate.
    const status = (
      CAT_FACTORY_TOOLS.find((t) => t.name === 'tasks_get')!.outputSchema!.properties as {
        status: { description: string }
      }
    ).status
    expect(status.description).toContain('planned')
    expect(status.description).toContain('may report a member not in this list')
    // A `204` has no object to describe, and claiming one would oblige the facade to return
    // structured content it does not have.
    expect(CAT_FACTORY_TOOLS.find((t) => t.name === 'tasks_delete')!.outputSchema).toBeUndefined()
  })

  it('leaves a response union asserting NOTHING but its discriminator, in prose', () => {
    // The union is the one place where dropping the `anyOf` is not enough. Every union on this
    // surface has object variants today, so `type: 'object'` would be accurate about the spec as it
    // stands and would still be the assertion this mode exists to remove: the IR resolves each
    // `oneOf` branch generically, so a future response union with a string or array variant would
    // have its honest answer rejected by an older copy of this package. The nullable-pair rule
    // above cannot see this, because a union rendered on the way out carries no `anyOf` at all.
    const decisions = CAT_FACTORY_TOOLS.find((tool) => tool.name === 'decisions_list')!
    const items = (
      decisions.outputSchema!.properties as { decisions: { items: Record<string, unknown> } }
    ).decisions.items
    expect(Object.keys(items)).toEqual(['description'])
    // What a model actually reads: the discriminator, its known members, and that the list is open.
    expect(items.description).toContain('Discriminated by `kind`')
    expect(items.description).toContain('may report a variant not in this list')
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

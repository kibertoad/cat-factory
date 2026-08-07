import { describe, expect, it } from 'vitest'
import {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  bindingByName,
  bindingsWithinScope,
  scopeSatisfies,
} from '../src/index.js'
import type { CatFactoryClient } from '@cat-factory/sdk'

// Structural relations over the GENERATED table, derived from the table itself rather than
// pinned counts: `pnpm check:sdk` already proves the table matches the spec byte for byte, so
// what belongs here is what a regenerate-and-diff structurally cannot see (an emitter bug that is
// consistent in both halves), plus the hand-written helpers.

describe('scope ladder helpers', () => {
  it('ranks the ladder inclusively', () => {
    for (const [i, have] of PUBLIC_API_SCOPE_LADDER.entries()) {
      for (const [j, need] of PUBLIC_API_SCOPE_LADDER.entries()) {
        expect(scopeSatisfies(have, need)).toBe(i >= j)
      }
    }
  })

  it('filters bindings monotonically: a wider key sees a superset', () => {
    let previous = 0
    for (const scope of PUBLIC_API_SCOPE_LADDER) {
      const visible = bindingsWithinScope(scope)
      expect(visible.length).toBeGreaterThanOrEqual(previous)
      previous = visible.length
      for (const binding of visible) {
        expect(scopeSatisfies(scope, binding.minScope)).toBe(true)
      }
    }
    // The top rung sees the whole surface; anything else means a binding declares a floor the
    // ladder does not reach, which the emitter refuses at generation time.
    expect(
      bindingsWithinScope(PUBLIC_API_SCOPE_LADDER[PUBLIC_API_SCOPE_LADDER.length - 1]!),
    ).toHaveLength(GATEKEEPER_BINDINGS.length)
  })
})

describe('the generated table', () => {
  it('names every binding uniquely and resolves each by name', () => {
    const names = new Set<string>()
    for (const binding of GATEKEEPER_BINDINGS) {
      expect(names.has(binding.name)).toBe(false)
      names.add(binding.name)
      expect(bindingByName(binding.name)).toBe(binding)
    }
    expect(bindingByName('no_such_operation')).toBeUndefined()
  })

  it.each(GATEKEEPER_BINDINGS.map((binding) => [binding.name, binding] as const))(
    '%s is internally consistent',
    (_name, binding) => {
      // readOnly is a statement about the METHOD; a drifted emitter would ship a policy table
      // that waves mutations through as reads.
      expect(binding.readOnly).toBe(binding.httpMethod === 'GET')
      // Every declared path param appears in the path template, and vice versa.
      const templateParams = [...binding.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      expect([...binding.pathParams]).toEqual(templateParams)
      // A consequence annotation on a read says nothing (the MCP emitter refuses those too).
      if (binding.consequence) expect(binding.readOnly).toBe(false)
    },
  )

  it.each(GATEKEEPER_BINDINGS.map((binding) => [binding.name, binding] as const))(
    '%s invoke() forwards to its own group and method',
    async (_name, binding) => {
      const calls: { group: string; method: string; args: unknown[] }[] = []
      const client = new Proxy(
        {},
        {
          get: (_target, group: string) =>
            new Proxy(
              {},
              {
                get:
                  (_inner, method: string) =>
                  (...args: unknown[]) => {
                    calls.push({ group, method, args })
                    return Promise.resolve('ok')
                  },
              },
            ),
        },
      ) as CatFactoryClient
      const args: Record<string, unknown> = { body: {} }
      for (const param of binding.pathParams) args[param] = `id-${param}`
      await binding.invoke(client, args)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.group).toBe(binding.group)
      expect(calls[0]!.method).toBe(binding.method)
      // Path params arrive positionally and in order, ahead of any body or query argument.
      expect(calls[0]!.args.slice(0, binding.pathParams.length)).toEqual(
        binding.pathParams.map((param) => `id-${param}`),
      )
    },
  )

  it('drops unknown keys instead of forwarding them as query parameters', async () => {
    const withQuery = GATEKEEPER_BINDINGS.find((binding) => binding.queryParams.length > 0)
    expect(withQuery).toBeDefined()
    let forwarded: unknown
    const client = new Proxy(
      {},
      {
        get: () =>
          new Proxy(
            {},
            {
              get:
                () =>
                (...args: unknown[]) => {
                  forwarded = args[args.length - 1]
                  return Promise.resolve('ok')
                },
            },
          ),
      },
    ) as CatFactoryClient
    const args: Record<string, unknown> = { body: {}, typoedFilter: 'x' }
    for (const param of withQuery!.pathParams) args[param] = 'id'
    const known = withQuery!.queryParams[0]!
    args[known] = 'kept'
    await withQuery!.invoke(client, args)
    expect(forwarded).toEqual({ [known]: 'kept' })
  })
})

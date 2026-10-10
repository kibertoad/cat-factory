import { describe, expect, it } from 'vitest'
import {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  SESSION_METHOD_SIGNATURES,
  TELEMETRY_BINDINGS,
  bindingByName,
  bindingsWithinScope,
  renderSessionTypes,
  resolveConsequence,
  scopeSatisfies,
} from '../src/index.js'
import type { PublicApiScope } from '../src/index.js'
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

  // A rung this package has not got is version skew, and the honest answer says so. Ranking it -1
  // would make `scopeSatisfies` answer `false` and `bindingsWithinScope` answer `[]`, which reads
  // as a key that may do nothing: the same value a correctly-ranked `read` key would get if the
  // whole table were admin-only, and the opposite fact.
  it('refuses a scope the ladder does not carry, rather than ranking it below everything', () => {
    const unknown = 'decide:own' as PublicApiScope
    expect(() => scopeSatisfies(unknown, 'read')).toThrow(TypeError)
    expect(() => scopeSatisfies('read', unknown)).toThrow(TypeError)
    expect(() => bindingsWithinScope(unknown)).toThrow(/decide:own/)
  })
})

describe('resolveConsequence', () => {
  it('reads a GET as safe and idempotent', () => {
    const read = GATEKEEPER_BINDINGS.find((binding) => binding.readOnly)!
    expect(resolveConsequence(read)).toEqual({ destructive: false, idempotent: true })
  })

  // The bug this exists to prevent: `binding.consequence?.destructive` answers `false` for an
  // unannotated mutation, so a front-end filtering on it exposes exactly the calls it meant to
  // hold back. The table annotates only the money/merge cases, so the unannotated mutations are
  // the MAJORITY, not an edge.
  it('reads an unannotated mutation as destructive and non-idempotent', () => {
    const unannotated = GATEKEEPER_BINDINGS.filter(
      (binding) => !binding.readOnly && !binding.consequence,
    )
    expect(unannotated.length).toBeGreaterThan(0)
    for (const binding of unannotated) {
      expect(resolveConsequence(binding)).toEqual({ destructive: true, idempotent: false })
    }
  })

  it('defers to the annotation where the table carries one', () => {
    const annotated = GATEKEEPER_BINDINGS.filter((binding) => binding.consequence)
    expect(annotated.length).toBeGreaterThan(0)
    for (const binding of annotated) {
      expect(resolveConsequence(binding)).toEqual(binding.consequence)
    }
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
      // The required query parameters too: this test is about WHERE a call is forwarded, and a
      // binding that declares one is refused before it gets that far (asserted on its own
      // below). Optional ones stay absent, so the forwarded bag is still only what was supplied.
      for (const param of binding.queryParams) {
        if (param.required) args[param.name] = `q-${param.name}`
      }
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

  // `invoke` is typed as returning a Promise, and a policy layer forwards an argument bag it did
  // not build. A synchronous throw from `str()` would escape past a caller's `.catch()`, so the
  // missing-argument case has to arrive as a rejection like every SDK failure does.
  it('rejects rather than throws when a required path parameter is missing', async () => {
    const withPath = GATEKEEPER_BINDINGS.find((binding) => binding.pathParams.length > 0)!
    // A client that would answer if it were reached, so the rejection is the missing argument and
    // not an incidental read off a stub.
    const client = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => () => Promise.resolve('ok') }) },
    ) as CatFactoryClient
    let returned: unknown
    expect(() => {
      returned = withPath.invoke(client, { body: {} })
    }).not.toThrow()
    await expect(returned).rejects.toThrow(withPath.pathParams[0]!)
  })

  it('drops unknown keys instead of forwarding them as query parameters', async () => {
    // Deliberately a binding whose query is ENTIRELY optional: with a required parameter in play
    // `pick` refuses before it forwards anything, so the assertion below would be about the
    // refusal rather than about what a supplied bag turns into.
    const withQuery = GATEKEEPER_BINDINGS.find(
      (binding) =>
        binding.queryParams.length > 0 && binding.queryParams.every((param) => !param.required),
    )
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
    const known = withQuery!.queryParams[0]!.name
    args[known] = 'kept'
    await withQuery!.invoke(client, args)
    expect(forwarded).toEqual({ [known]: 'kept' })
  })

  // The query half of the rule the path half states above. `pick` narrows its result to the SDK
  // method's own query type, and that narrowing is only honest if the required parameters are
  // known to be there: without the check the binding forwarded a bag it had just been allowed to
  // drop the one field from, and the caller learned about it as a 400 from a call that never had
  // to be made. Read off the table rather than named, so a second required parameter is covered
  // the day it appears.
  it('rejects when a required query parameter is missing', async () => {
    const withRequired = GATEKEEPER_BINDINGS.filter((binding) =>
      binding.queryParams.some((param) => param.required),
    )
    expect(
      withRequired.length,
      'no binding declares a required query parameter: if the surface genuinely lost its last ' +
        'one, retire this test deliberately rather than leaving it asserting nothing',
    ).toBeGreaterThan(0)
    const client = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => () => Promise.resolve('ok') }) },
    ) as CatFactoryClient
    for (const binding of withRequired) {
      const args: Record<string, unknown> = { body: {} }
      for (const param of binding.pathParams) args[param] = 'id'
      // Every OPTIONAL one supplied, so the rejection can only be about the omitted required one
      // rather than about an empty bag in general.
      for (const param of binding.queryParams) if (!param.required) args[param.name] = 'x'
      const missing = binding.queryParams.find((param) => param.required)!
      let returned: unknown
      expect(() => {
        returned = binding.invoke(client, args)
      }).not.toThrow()
      await expect(returned).rejects.toThrow(missing.name)
    }
  })

  // What the deny set in a Gatekeeper policy is derived from. The relation, not the membership: a
  // pinned list of names is exactly what let the LLM export ship readable by an oversight tier
  // that withheld every sibling read of the same sink.
  it('derives the telemetry deny set from the table itself', () => {
    const byName = new Map(GATEKEEPER_BINDINGS.map((binding) => [binding.name, binding]))
    expect(TELEMETRY_BINDINGS.length).toBeGreaterThan(0)
    for (const name of TELEMETRY_BINDINGS) {
      expect(byName.get(name)?.telemetrySink, `${name} is on the deny set`).toBeDefined()
    }
    for (const binding of GATEKEEPER_BINDINGS) {
      expect(
        TELEMETRY_BINDINGS.includes(binding.name),
        `${binding.name} declares a telemetry sink`,
      ).toBe(binding.telemetrySink !== undefined)
      // Withholding them is a POLICY decision, which is only meaningful while the platform's own
      // floor still admits them: a sink read that needed `admin` would be denied by the key, and
      // a tier author reading this list would be governing something already out of reach.
      if (binding.telemetrySink) expect(binding.minScope).toBe('read')
    }
  })
})

describe('the session type declarations', () => {
  // The relation the emitter cannot state about itself: the two generated artifacts describe the
  // same surface. A regenerate-and-diff check passes an emitter whose bug is consistent in both
  // halves, and a table with no signature for a binding is a session method that silently vanishes.
  it('carries exactly one signature per binding', () => {
    expect(SESSION_METHOD_SIGNATURES.map((signature) => signature.name).sort()).toEqual(
      GATEKEEPER_BINDINGS.map((binding) => binding.name).sort(),
    )
  })

  it.each(SESSION_METHOD_SIGNATURES.map((signature) => [signature.name, signature] as const))(
    '%s declares the arguments its own binding reads',
    (name, signature) => {
      const binding = bindingByName(name)
      expect(binding).toBeDefined()
      // A path parameter is required by construction (a path with a hole in it is not a route), so
      // it must be declared and must not be optional. Getting this backwards would hand a caller a
      // type saying an argument is optional and a runtime that throws without it.
      for (const param of binding!.pathParams) {
        expect(signature.signature).toContain(`${param}: string`)
      }
      for (const param of binding!.queryParams) {
        expect(signature.signature).toContain(`${param.name}${param.required ? '' : '?'}:`)
      }
      // Matched as a whole field name: `debug_get_llm_call` takes query parameters called
      // `bodyChars` and `bodyOffset`, so a substring test would report a request body on a GET.
      expect(/\bbody\??:/.test(signature.signature)).toBe(binding!.hasBody)
    },
  )

  it('renders only what was asked for, in the order it was asked for', () => {
    const rendered = renderSessionTypes({
      interfaceName: 'TestSession',
      bindings: ['tasks_create', 'services_list'],
      extraMembers: ['  reserved(): Promise<void>\n'],
    })

    expect(rendered).toContain('export interface TestSession {')
    expect(rendered).toContain('reserved(): Promise<void>')
    expect(rendered.indexOf('tasks_create(')).toBeLessThan(rendered.indexOf('services_list('))
    expect(rendered).not.toContain('tasks_start(')
  })

  // Skipping silently is the failure worth refusing: to an agent reading the types, a method that
  // was dropped is indistinguishable from an operation this deployment does not serve, and the two
  // need opposite fixes (upgrade the package / change the policy).
  it('refuses a name it has no signature for rather than dropping it', () => {
    expect(() =>
      renderSessionTypes({ interfaceName: 'TestSession', bindings: ['no_such_operation'] }),
    ).toThrow(/No session signature for binding 'no_such_operation'/)
  })
})

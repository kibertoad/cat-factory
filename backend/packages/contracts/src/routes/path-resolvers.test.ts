import { describe, expect, it } from 'vitest'
import { mapApiContractToPath } from '@toad-contracts/core'
import * as routes from './index.js'

// A `pathResolver` has TWO callers and only one of them passes real values. A client passes the
// id it wants; ROUTE REGISTRATION passes the literal placeholder `:taskType`, and whatever comes
// back is the pattern Hono matches requests against. A resolver that transforms its input
// therefore transforms the placeholder too, and the route silently registers as something no
// request can reach.
//
// That is not a hypothetical: `encodeURIComponent(taskType)` in the operation-suppression pair
// registered `PUT /task-type-suppressions/%3AtaskType`, so every hide and every restore 404'd
// while the paramless list beside them answered normally. Nothing failed to compile, the client
// built the right URL, and the RBAC suite's own assertion for those routes read the 404 as the
// refusal it was checking for.
//
// These assert the registered PATTERN rather than any one resolver's body, so a new contract is
// covered by existing here rather than by someone remembering to add a case.

/**
 * The two members every contract carries that these assertions need. Structural rather than the
 * emitter's own parameter type, which is the union of every declared contract shape and so cannot
 * be narrowed to from `unknown` by a predicate.
 */
type AnyContract = {
  method: string
  pathResolver: (params: never) => string
  requestPathParamsSchema?: { '~standard': { objectKeys: { input: () => readonly string[] } } }
}

const isContract = (value: unknown): value is AnyContract =>
  typeof value === 'object' && value !== null && 'pathResolver' in value && 'method' in value

/** Every exported API contract, by export name. */
function contracts(): [string, AnyContract][] {
  return Object.entries(routes as Record<string, unknown>).filter(
    (entry): entry is [string, AnyContract] => isContract(entry[1]),
  )
}

/** The Hono pattern this contract registers as. */
const patternOf = (contract: AnyContract): string =>
  mapApiContractToPath(contract as Parameters<typeof mapApiContractToPath>[0])

describe('every route contract registers a routable path', () => {
  it('finds contracts to check at all', () => {
    // Derived from the barrel, so it grows on its own; the floor only catches the day this file
    // starts asserting nothing because the export shape moved under it.
    expect(contracts().length).toBeGreaterThan(50)
  })

  it.each(contracts().map(([name, contract]) => [name, contract] as const))(
    '%s resolves to a pattern with no percent-encoding',
    (_name, contract) => {
      // A `%` can only come from a resolver encoding its own input, because every path this repo
      // declares is ASCII. The placeholder is what gets encoded, and the route stops matching.
      expect(patternOf(contract)).not.toContain('%')
    },
  )

  it.each(contracts().map(([name, contract]) => [name, contract] as const))(
    '%s places every path param it declares',
    (_name, contract) => {
      // The general form of the same bug: a declared param that does not reach the pattern as
      // `:key` is a param nothing binds, whatever the resolver did with it.
      const keys = contract.requestPathParamsSchema?.['~standard'].objectKeys.input() ?? []
      const path = patternOf(contract)
      for (const key of keys) {
        expect(path.split('/'), `${path} is missing :${key}`).toContain(`:${key}`)
      }
    },
  )
})

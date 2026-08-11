import { describe, expect, it } from 'vitest'
import { mapApiContractToPath } from '@toad-contracts/core'
import { PUBLIC_API_SCOPES } from '../public-api-keys.js'
import * as routes from './index.js'

// `minScope` (see `withMinScope` in `./_shared.ts`) is the scope floor the controllers ENFORCE
// and the OpenAPI generator publishes as `x-min-scope`, so these assert the structural rules the
// annotation must keep, derived from the barrel rather than from a hand-list, exactly like
// `path-resolvers.test.ts` next door.
//
// The one rule that needs a test rather than a reference: the parked-decision mutations do not
// authorize per route. They all gate through `gateDecisionAction` (the server's
// `publicApi/decisions/scope.ts`), which holds a single `'decide'` literal, so a decision
// contract whose annotation drifted from that literal would publish a floor the deployment does
// not enforce. Every other public route reads `contract.minScope` directly and cannot drift.

type AnyContract = {
  method: string
  pathResolver: (params: never) => string
  minScope?: unknown
  personalUnlock?: unknown
}

const isContract = (value: unknown): value is AnyContract =>
  typeof value === 'object' && value !== null && 'pathResolver' in value && 'method' in value

/** Every exported API contract, by export name. */
function contracts(): [string, AnyContract][] {
  return Object.entries(routes as Record<string, unknown>).filter(
    (entry): entry is [string, AnyContract] => isContract(entry[1]),
  )
}

const patternOf = (contract: AnyContract): string =>
  mapApiContractToPath(contract as Parameters<typeof mapApiContractToPath>[0])

const publicContracts = () => contracts().filter(([, c]) => patternOf(c).startsWith('/api/v1'))

describe('public-API scope floors', () => {
  it('finds public contracts to check at all', () => {
    expect(publicContracts().length).toBeGreaterThan(50)
  })

  it.each(publicContracts().map(([name, contract]) => [name, contract] as const))(
    '%s declares a minScope from the ladder',
    (_name, contract) => {
      expect(PUBLIC_API_SCOPES).toContain(contract.minScope)
    },
  )

  it.each(
    publicContracts()
      .filter(([, c]) => patternOf(c).startsWith('/api/v1/runs/') && c.method !== 'get')
      .map(([name, contract]) => [name, contract] as const),
  )(
    '%s (a decision mutation) declares the decide floor gateDecisionAction enforces',
    (_name, contract) => {
      expect(contract.minScope).toBe('decide')
    },
  )

  it.each(
    contracts()
      .filter(([, c]) => !patternOf(c).startsWith('/api/v1'))
      .map(([name, contract]) => [name, contract] as const),
  )('%s (session-authed) carries no minScope', (_name, contract) => {
    // The field is a public-surface concept; on a session-authed contract it would claim a floor
    // nothing reads, and the next reader would trust it.
    expect(contract.minScope).toBeUndefined()
  })
})

// The personal-unlock header (`withPersonalUnlock`) is the second annotation the published spec is
// generated from, and the one a NEW route is most likely to omit: the server reads it in shared
// preambles (`gateDecisionAction`, `personalUnlockFor`), so a route inherits the behaviour without
// naming it, and only the declaration makes it appear in `docs/openapi.json`. Derived from the
// barrel for the same reason the floors above are.
describe('public-API personal-unlock declarations', () => {
  const decisionMutations = () =>
    publicContracts().filter(
      ([, c]) => patternOf(c).startsWith('/api/v1/runs/') && c.method !== 'get',
    )

  it('finds decision mutations to check at all', () => {
    expect(decisionMutations().length).toBeGreaterThan(20)
  })

  it.each(decisionMutations().map(([name, contract]) => [name, contract] as const))(
    '%s (answers a park, so wakes the run) declares the personal-unlock header',
    (_name, contract) => {
      expect(contract.personalUnlock).toBe(true)
    },
  )

  it.each(
    (
      ['createPublicJobContract', 'startPublicTaskContract', 'retryPublicTaskContract'] as const
    ).map((name) => [name] as const),
  )('%s (starts or re-drives a run) declares the personal-unlock header', (name) => {
    const contract = contracts().find(([exportName]) => exportName === name)?.[1]
    expect(contract?.personalUnlock).toBe(true)
  })

  it('leaves the read-only decision list undeclared', () => {
    // A GET answers no park and wakes nothing, so declaring the header there would publish an
    // input the route does not read — the same misreport the declarations exist to prevent, with
    // the sign flipped.
    const list = contracts().find(([name]) => name === 'listPublicRunDecisionsContract')?.[1]
    expect(list?.personalUnlock).toBeUndefined()
  })
})

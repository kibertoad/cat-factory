import { describe, expect, it } from 'vitest'
import { binaryGeneratorDefinitionIssues, isHarnessTransport } from './binary-generators.js'

// The TRANSPORT axis: whether an integration is a vendor API the agent's own code calls, or a tool
// built into the agent CLI the step dispatches under.
//
// Every rule here is a fault WITHIN one definition, which is why it lives in the schema rather
// than in boot validation: no other definition, no registry and no runtime is needed to see it.
// What boot still owns is the one check that needs more context — whether the named harness is one
// this build actually runs.

const api = {
  id: 'acme-images',
  name: 'Acme Images',
  summary: 'Generates images',
  description: '',
  modalities: ['image'],
}

describe('isHarnessTransport', () => {
  it('reads an ABSENT transport as api, which is what every pre-existing definition meant', () => {
    // The reason this is a helper and not `=== 'harness'` at each site: the field is optional, and
    // a reader that forgot which way the default falls would treat every integration registered
    // before this axis existed as harness-served.
    expect(isHarnessTransport({})).toBe(false)
    expect(isHarnessTransport({ transport: 'api' })).toBe(false)
    expect(isHarnessTransport({ transport: 'harness' })).toBe(true)
  })
})

describe('the transport discriminator', () => {
  it('accepts an api integration with an endpoint and a credential (the unchanged shape)', () => {
    expect(
      binaryGeneratorDefinitionIssues({
        ...api,
        endpoint: 'https://api.acme.test/v1',
        credentials: [{ key: 'ACME_IMAGE_API_KEY' }],
      }),
    ).toEqual([])
  })

  it('accepts a harness integration that names its CLI and declares no API', () => {
    expect(
      binaryGeneratorDefinitionIssues({ ...api, transport: 'harness', harness: 'codex' }),
    ).toEqual([])
  })

  it('refuses a harness transport that names no harness', () => {
    // Without it there is nothing to pin the step to, so the reachability check cannot run and the
    // integration is admitted for every CLI — including the ones with no such tool.
    const issues = binaryGeneratorDefinitionIssues({ ...api, transport: 'harness' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('must name the `harness`')
  })

  it('refuses a harness named on an api transport', () => {
    // The reverse lie: it reads as a pinned integration while nothing pins it.
    const issues = binaryGeneratorDefinitionIssues({ ...api, harness: 'codex' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('only a harness-transport integration')
  })

  it('refuses a CREDENTIAL on a harness transport, the one that actually bites', () => {
    // `endpoint` and `contracts` would only mislead the brief. A credential is injected into the
    // agent's process, so this is a variable the deployment believes authenticates something and
    // that nothing ever reads — the auth is the leased subscription the run already used.
    const issues = binaryGeneratorDefinitionIssues({
      ...api,
      transport: 'harness',
      harness: 'codex',
      credentials: [{ key: 'ACME_IMAGE_API_KEY' }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('no API')
  })

  it('refuses an endpoint or contracts on a harness transport', () => {
    expect(
      binaryGeneratorDefinitionIssues({
        ...api,
        transport: 'harness',
        harness: 'codex',
        endpoint: 'https://api.acme.test/v1',
      }),
    ).toHaveLength(1)
    expect(
      binaryGeneratorDefinitionIssues({
        ...api,
        transport: 'harness',
        harness: 'codex',
        contracts: [{ contractId: 'api', format: 'openapi', title: 'API', body: '{}' }],
      }),
    ).toHaveLength(1)
  })

  it('refuses a transport outside the closed vocabulary', () => {
    expect(binaryGeneratorDefinitionIssues({ ...api, transport: 'grpc' })).not.toEqual([])
  })
})

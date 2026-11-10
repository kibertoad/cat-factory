import { describe, expect, it } from 'vitest'
import { parseProjectDefinition, projectDefinitionNamespace } from './project-definitions.js'
import { researchSpecValidator } from './research.js'

const envelope = {
  kind: 'notes',
  key: 'acme:vendor',
  version: 1,
  title: 'Notes',
  spec: { anything: ['the kind decides'] },
}

describe('project definition envelope', () => {
  it('accepts any spec and fills the optional envelope lists', () => {
    const parsed = parseProjectDefinition(envelope)
    expect(parsed).toEqual({
      ok: true,
      value: {
        ...envelope,
        credentials: [],
        targets: [],
        inputs: [],
        promptAdditions: {},
      },
    })
  })

  it('refuses a key without a namespace, a non-https target and a reserved credential key', () => {
    expect(parseProjectDefinition({ ...envelope, key: 'vendor' }).ok).toBe(false)
    expect(
      parseProjectDefinition({
        ...envelope,
        targets: [{ baseUrl: 'http://vendor.example', surface: 'api' }],
      }).ok,
    ).toBe(false)
    expect(
      parseProjectDefinition({
        ...envelope,
        credentials: [
          { key: 'ENCRYPTION_KEY', kind: 'secret', label: 'Sealing key', requiredAtStart: true },
        ],
      }).ok,
    ).toBe(false)
  })

  it('refuses a credential onboarding link unless it is http or https', () => {
    const credential = (url: string) =>
      parseProjectDefinition({
        ...envelope,
        credentials: [
          {
            key: 'VENDOR_TOKEN',
            kind: 'api-token',
            label: 'Vendor token',
            onboarding: { url, instructions: 'Create a token.' },
            requiredAtStart: true,
          },
        ],
      }).ok
    expect(credential('https://vendor.example/tokens')).toBe(true)
    expect(credential('javascript:alert(1)')).toBe(false)
  })

  it('leaves the spec to its kind: research refuses an envelope another kind would accept', () => {
    const parsed = parseProjectDefinition({ ...envelope, kind: 'research' })
    if (!parsed.ok) throw new Error('envelope fixture invalid')
    expect(researchSpecValidator.parseSpec(parsed.value).ok).toBe(false)
  })

  it('reads the namespace off a key', () => {
    expect(projectDefinitionNamespace('acme:content-integration')).toBe('acme')
  })
})

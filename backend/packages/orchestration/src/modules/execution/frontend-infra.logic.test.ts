import { describe, expect, it } from 'vitest'
import type { FrontendConfig } from '@cat-factory/kernel'
import { duplicateBindingEnvVars } from '@cat-factory/contracts'
import {
  hasLiveServiceBinding,
  hasServiceBinding,
  resolveFrontendBindings,
} from './frontend-infra.logic.js'

/** A minimal frontend config with the given bindings (defaults for the build/serve knobs). */
function config(backendBindings: FrontendConfig['backendBindings']): FrontendConfig {
  return { backendBindings }
}

describe('resolveFrontendBindings', () => {
  it('resolves a service binding with a live env to the ephemeral URL (the service under test)', () => {
    const cfg = config([
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
    ])
    const live = new Map([['blk_api', 'https://api.ephemeral.example']])
    expect(resolveFrontendBindings(cfg, live)).toEqual([
      { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
    ])
  })

  it('leaves a service binding with NO live env to be mocked (no serviceUrl)', () => {
    const cfg = config([
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
    ])
    expect(resolveFrontendBindings(cfg, new Map())).toEqual([{ envVar: 'PUB_API_URL' }])
  })

  it('leaves a mock binding to be mocked (no serviceUrl), regardless of live envs', () => {
    const cfg = config([{ envVar: 'PUB_OTHER_URL', source: { kind: 'mock' } }])
    const live = new Map([['blk_api', 'https://api.ephemeral.example']])
    expect(resolveFrontendBindings(cfg, live)).toEqual([{ envVar: 'PUB_OTHER_URL' }])
  })

  it('drops empty-envVar bindings (an unfinished inspector row) so nothing inert is injected', () => {
    const cfg = config([
      { envVar: '', source: { kind: 'mock' } },
      { envVar: '   ', source: { kind: 'service', serviceBlockId: 'blk_api' } },
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
    ])
    const live = new Map([['blk_api', 'https://api.ephemeral.example']])
    expect(resolveFrontendBindings(cfg, live)).toEqual([
      { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
    ])
  })

  it('resolves a mixed config (one live service under test, the rest mocked)', () => {
    const cfg = config([
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
      { envVar: 'PUB_BILLING_URL', source: { kind: 'service', serviceBlockId: 'blk_billing' } },
      { envVar: 'PUB_ANALYTICS_URL', source: { kind: 'mock' } },
    ])
    const live = new Map([['blk_api', 'https://api.ephemeral.example']])
    expect(resolveFrontendBindings(cfg, live)).toEqual([
      { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
      { envVar: 'PUB_BILLING_URL' },
      { envVar: 'PUB_ANALYTICS_URL' },
    ])
  })

  it('dedupes a repeated env var deterministically (last non-empty binding wins)', () => {
    // The injected env is a map keyed by envVar; a duplicate must resolve to ONE value, and it
    // must be the last one the operator sees in the list — not left to insertion-order chance.
    const cfg = config([
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_other' } },
    ])
    const live = new Map([
      ['blk_api', 'https://api.ephemeral.example'],
      ['blk_other', 'https://other.ephemeral.example'],
    ])
    expect(resolveFrontendBindings(cfg, live)).toEqual([
      { envVar: 'PUB_API_URL', serviceUrl: 'https://other.ephemeral.example' },
    ])
  })
})

describe('duplicateBindingEnvVars', () => {
  it('reports a non-empty env var used on more than one binding', () => {
    const cfg = config([
      { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
      { envVar: 'PUB_API_URL', source: { kind: 'mock' } },
    ])
    expect(duplicateBindingEnvVars(cfg)).toEqual(['PUB_API_URL'])
  })

  it('ignores empty/whitespace env vars (unfinished rows) and returns sorted uniques', () => {
    const cfg = config([
      { envVar: 'B', source: { kind: 'mock' } },
      { envVar: 'B', source: { kind: 'mock' } },
      { envVar: 'A', source: { kind: 'mock' } },
      { envVar: 'A', source: { kind: 'mock' } },
      { envVar: '  ', source: { kind: 'mock' } },
      { envVar: '  ', source: { kind: 'mock' } },
    ])
    expect(duplicateBindingEnvVars(cfg)).toEqual(['A', 'B'])
  })

  it('is empty when every (non-empty) env var is unique', () => {
    const cfg = config([
      { envVar: 'PUB_A', source: { kind: 'mock' } },
      { envVar: 'PUB_B', source: { kind: 'mock' } },
    ])
    expect(duplicateBindingEnvVars(cfg)).toEqual([])
  })
})

describe('hasLiveServiceBinding', () => {
  it('is true when any binding has a resolved service URL', () => {
    expect(hasLiveServiceBinding([{ envVar: 'A' }, { envVar: 'B', serviceUrl: 'https://x' }])).toBe(
      true,
    )
  })

  it('is false when every binding is mocked (no service under test)', () => {
    expect(hasLiveServiceBinding([{ envVar: 'A' }, { envVar: 'B' }])).toBe(false)
  })

  it('is false for an empty binding list', () => {
    expect(hasLiveServiceBinding([])).toBe(false)
  })
})

describe('hasServiceBinding', () => {
  it('is true when any binding has a (non-empty) service source', () => {
    expect(
      hasServiceBinding(
        config([{ envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } }]),
      ),
    ).toBe(true)
  })

  it('is false for a mock-only frontend', () => {
    expect(hasServiceBinding(config([{ envVar: 'PUB_OTHER_URL', source: { kind: 'mock' } }]))).toBe(
      false,
    )
  })

  it('is false when the only service binding has an empty env var (an unfinished row)', () => {
    expect(
      hasServiceBinding(
        config([{ envVar: '  ', source: { kind: 'service', serviceBlockId: 'blk_api' } }]),
      ),
    ).toBe(false)
  })

  it('is false for an empty binding list', () => {
    expect(hasServiceBinding(config([]))).toBe(false)
  })
})

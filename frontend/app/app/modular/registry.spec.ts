import { defineModule } from '@modular-vue/core'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetConsumerModulesForTest, createAppRegistry, registerAppModule } from './registry'

describe('app modular registry', () => {
  afterEach(() => {
    __resetConsumerModulesForTest()
  })

  it('registers the first-party core module', () => {
    const manifest = createAppRegistry().resolveManifest()
    expect(manifest.modules.map((m) => m.id)).toContain('cat-factory:core')
  })

  it('includes consumer modules contributed via registerAppModule', () => {
    registerAppModule(defineModule({ id: 'consumer:example', version: '1.0.0' }))

    const ids = createAppRegistry()
      .resolveManifest()
      .modules.map((m) => m.id)

    expect(ids).toContain('cat-factory:core')
    expect(ids).toContain('consumer:example')
  })

  it('rejects a module whose id collides with an already-registered one', () => {
    registerAppModule(defineModule({ id: 'cat-factory:core', version: '2.0.0' }))

    expect(() => createAppRegistry().resolveManifest()).toThrow(/duplicate/i)
  })
})

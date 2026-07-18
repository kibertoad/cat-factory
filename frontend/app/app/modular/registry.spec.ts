import { defineModule } from '@modular-vue/core'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetConsumerModulesForTest, createAppRegistry, registerAppModule } from './registry'
import type { NavGates } from './nav-contributions'

const NO_GATES: NavGates = {
  canWriteBoard: false,
  canManageIntegrations: false,
  canManageSettings: false,
  githubAvailable: false,
  libraryAvailable: false,
  infrastructureAvailable: false,
  accountsEnabled: false,
  isAccountAdmin: false,
}

describe('app modular registry', () => {
  afterEach(() => {
    __resetConsumerModulesForTest()
  })

  it('registers the first-party navigation module', () => {
    const manifest = createAppRegistry({ gates: NO_GATES }).resolveManifest()
    expect(manifest.modules.map((m) => m.id)).toContain('cat-factory:navigation')
  })

  it('includes consumer modules contributed via registerAppModule', () => {
    registerAppModule(defineModule({ id: 'consumer:example', version: '1.0.0' }))

    const ids = createAppRegistry({ gates: NO_GATES })
      .resolveManifest()
      .modules.map((m) => m.id)

    expect(ids).toContain('cat-factory:navigation')
    expect(ids).toContain('consumer:example')
  })

  it('rejects a module whose id collides with an already-registered one', () => {
    registerAppModule(defineModule({ id: 'cat-factory:navigation', version: '2.0.0' }))

    expect(() => createAppRegistry({ gates: NO_GATES }).resolveManifest()).toThrow(/duplicate/i)
  })

  it('merges a consumer-contributed nav item into the resolved nav slot', () => {
    // A deployment extending the layer contributes its own nav destination to the
    // SAME `nav` slot the first-party module fills — it then renders in every shell
    // with no shell edits (the slice-1 extensibility promise).
    registerAppModule(
      defineModule({
        id: 'consumer:nav',
        version: '1.0.0',
        slots: {
          nav: [
            {
              id: 'consumer:reports',
              labelKey: 'consumer.reports',
              icon: 'i-lucide-bar-chart',
              surfaces: ['sidebar', 'toolbar'],
              action: 'openReports',
              sidebar: { group: 'configuration', order: 99 },
              toolbar: { order: 10 },
            },
          ],
        },
      }),
    )

    const slots = createAppRegistry({ gates: NO_GATES }).resolveManifest().slots as {
      nav: { id: string }[]
    }
    const ids = slots.nav.map((i) => i.id)
    // First-party catalog + the consumer item both present in one merged slot.
    expect(ids).toContain('build-pipeline')
    expect(ids).toContain('consumer:reports')
  })
})

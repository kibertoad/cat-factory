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

  it('merges consumer-contributed result-view + agent-kind slots (slice-2 extensibility)', () => {
    // A deployment ships its OWN dedicated window AND its custom agent kind through the
    // same slots the first-party modules use — no layer fork. A fake component (plain
    // object) stands in for the SFC so this stays a pure registry test.
    const fakeComponent = { name: 'AcmeReportWindow' }
    registerAppModule(
      defineModule({
        id: 'consumer:acme',
        version: '1.0.0',
        slots: {
          resultViews: [{ id: 'acme:report', component: fakeComponent }],
          agentKinds: [
            {
              kind: 'acme-audit',
              container: true,
              presentation: {
                label: 'Acme Audit',
                icon: 'i-lucide-shield',
                color: '#fff',
                description: 'd',
                resultView: 'acme:report',
              },
            },
          ],
        },
      }),
    )

    const slots = createAppRegistry({ gates: NO_GATES }).resolveManifest().slots as {
      resultViews: { id: string }[]
      agentKinds: { kind: string; presentation: { resultView?: string } }[]
    }
    expect(slots.resultViews.map((v) => v.id)).toContain('acme:report')
    const audit = slots.agentKinds.find((k) => k.kind === 'acme-audit')
    // The custom kind's resultView id pairs against the consumer's own registered component.
    expect(audit?.presentation.resultView).toBe('acme:report')
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

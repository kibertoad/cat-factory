import { describe, it, expect, beforeEach } from 'vitest'
import { useScenariosStore } from '~/stores/scenarios'

describe('scenarios store', () => {
  let store: ReturnType<typeof useScenariosStore>
  beforeEach(() => {
    store = useScenariosStore()
  })

  it('drafts the standard set of scenarios for a feature', () => {
    const created = store.generateForFeature('Login')
    expect(created).toHaveLength(3)
    expect(store.scenariosForFeature('Login')).toHaveLength(3)
    // Each is a Given/When/Then with the feature folded in.
    const happy = created[0]!
    expect(happy.feature).toBe('Login')
    expect(happy.when.join(' ')).toContain('Login')
    expect(happy.then.length).toBeGreaterThan(0)
    expect(happy.source).toBe('generated')
  })

  it('is additive: re-drafting only fills gaps and never duplicates', () => {
    store.generateForFeature('Login')
    const again = store.generateForFeature('Login')
    expect(again).toHaveLength(0)
    expect(store.scenariosForFeature('Login')).toHaveLength(3)

    // A removed scenario is re-created on the next draft, the rest are kept.
    const removed = store.scenariosForFeature('Login')[1]!
    store.removeScenario(removed.id)
    const refilled = store.generateForFeature('Login')
    expect(refilled).toHaveLength(1)
    expect(store.scenariosForFeature('Login')).toHaveLength(3)
  })

  it('matches features case- and whitespace-insensitively', () => {
    store.generateForFeature('User  Login')
    expect(store.hasScenarios('user login')).toBe(true)
    expect(store.scenariosForFeature('USER LOGIN')).toHaveLength(3)
  })

  it('folds linked requirements into the generated Given', () => {
    const [happy] = store.generateForFeature('Checkout', { requirements: ['Payments PRD'] })
    expect(happy!.given.join(' ')).toContain('Payments PRD')
  })

  it('collects scenarios across all of a block features', () => {
    store.generateForFeature('Login')
    store.generateForFeature('Logout')
    const forBlock = store.scenariosForBlock({ features: ['Login', 'Logout'] })
    expect(forBlock).toHaveLength(6)
    expect(store.scenariosForBlock({ features: [] })).toHaveLength(0)
  })

  it('generates Playwright tests only for scenarios that lack one (idempotent)', () => {
    store.generateForFeature('Login')
    expect(store.untested('Login')).toBe(3)

    const first = store.generatePlaywrightTests('Login')
    expect(first).toHaveLength(3)
    expect(store.untested('Login')).toBe(0)
    expect(store.scenariosForFeature('Login').every((s) => s.hasPlaywrightTest)).toBe(true)

    // Re-running creates nothing new...
    expect(store.generatePlaywrightTests('Login')).toHaveLength(0)

    // ...but a freshly added scenario does get a test on the next run.
    store.addScenario({ feature: 'Login', title: 'Login: remember me' })
    expect(store.untested('Login')).toBe(1)
    expect(store.generatePlaywrightTests('Login')).toHaveLength(1)
  })

  it('edits and removes scenarios', () => {
    const scenario = store.addScenario({ feature: 'Login', title: 'Draft' })
    store.updateScenario(scenario.id, { title: 'Renamed', status: 'approved' })
    expect(store.scenariosForFeature('Login')[0]!.title).toBe('Renamed')
    expect(store.scenariosForFeature('Login')[0]!.status).toBe('approved')

    store.removeScenario(scenario.id)
    expect(store.scenariosForFeature('Login')).toHaveLength(0)
  })
})

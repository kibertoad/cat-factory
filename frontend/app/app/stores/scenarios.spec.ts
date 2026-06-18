import { describe, it, expect, beforeEach } from 'vitest'
import { useScenariosStore } from '~/stores/scenarios'

describe('scenarios store', () => {
  let store: ReturnType<typeof useScenariosStore>
  beforeEach(() => {
    store = useScenariosStore()
  })

  it('drafts the standard set of scenarios for a task', () => {
    const created = store.generateForBlock('task_1', { subject: 'Login' })
    expect(created).toHaveLength(3)
    expect(store.scenariosForBlock('task_1')).toHaveLength(3)
    // Each is a Given/When/Then with the subject folded in.
    const happy = created[0]!
    expect(happy.blockId).toBe('task_1')
    expect(happy.when.join(' ')).toContain('Login')
    expect(happy.then.length).toBeGreaterThan(0)
    expect(happy.source).toBe('generated')
  })

  it('is additive: re-drafting only fills gaps and never duplicates', () => {
    store.generateForBlock('task_1', { subject: 'Login' })
    const again = store.generateForBlock('task_1', { subject: 'Login' })
    expect(again).toHaveLength(0)
    expect(store.scenariosForBlock('task_1')).toHaveLength(3)

    // A removed scenario is re-created on the next draft, the rest are kept.
    const removed = store.scenariosForBlock('task_1')[1]!
    store.removeScenario(removed.id)
    const refilled = store.generateForBlock('task_1', { subject: 'Login' })
    expect(refilled).toHaveLength(1)
    expect(store.scenariosForBlock('task_1')).toHaveLength(3)
  })

  it('folds linked requirements into the generated Given', () => {
    const [happy] = store.generateForBlock('task_1', {
      subject: 'Checkout',
      requirements: ['Payments PRD'],
    })
    expect(happy!.given.join(' ')).toContain('Payments PRD')
  })

  it('scopes scenarios to a single task', () => {
    store.generateForBlock('task_1', { subject: 'Login' })
    store.generateForBlock('task_2', { subject: 'Logout' })
    expect(store.scenariosForBlock('task_1')).toHaveLength(3)
    expect(store.scenariosForBlock('task_2')).toHaveLength(3)
    expect(store.scenariosForBlock('task_3')).toHaveLength(0)
  })

  it('generates Playwright tests only for scenarios that lack one (idempotent)', () => {
    store.generateForBlock('task_1', { subject: 'Login' })
    expect(store.untested('task_1')).toBe(3)

    const first = store.generatePlaywrightTests('task_1')
    expect(first).toHaveLength(3)
    expect(store.untested('task_1')).toBe(0)
    expect(store.scenariosForBlock('task_1').every((s) => s.hasPlaywrightTest)).toBe(true)

    // Re-running creates nothing new...
    expect(store.generatePlaywrightTests('task_1')).toHaveLength(0)

    // ...but a freshly added scenario does get a test on the next run.
    store.addScenario({ blockId: 'task_1', title: 'Login: remember me' })
    expect(store.untested('task_1')).toBe(1)
    expect(store.generatePlaywrightTests('task_1')).toHaveLength(1)
  })

  it('edits and removes scenarios', () => {
    const scenario = store.addScenario({ blockId: 'task_1', title: 'Draft' })
    store.updateScenario(scenario.id, { title: 'Renamed', status: 'approved' })
    expect(store.scenariosForBlock('task_1')[0]!.title).toBe('Renamed')
    expect(store.scenariosForBlock('task_1')[0]!.status).toBe('approved')

    store.removeScenario(scenario.id)
    expect(store.scenariosForBlock('task_1')).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { datadogAuthRemedy } from './datadog.logic.js'

// D4: a Datadog auth rejection surfaces a UI-first remedy naming the keys panel, not a bare
// `HTTP 403`. The keys are UI-configured, so the remedy points at Integrations → Observability
// connection and mentions no env var (there is none for this connection).
describe('datadogAuthRemedy', () => {
  it('returns the keys-panel remedy for a 401', () => {
    const remedy = datadogAuthRemedy(401)
    expect(remedy).toContain('Integrations → Observability connection')
    expect(remedy).toContain('API and Application keys')
  })

  it('returns the keys-panel remedy for a 403', () => {
    expect(datadogAuthRemedy(403)).toContain('Integrations → Observability connection')
  })

  it('returns undefined for non-auth statuses (a 5xx / mapping error is not a key problem)', () => {
    expect(datadogAuthRemedy(500)).toBeUndefined()
    expect(datadogAuthRemedy(404)).toBeUndefined()
    expect(datadogAuthRemedy(200)).toBeUndefined()
  })
})

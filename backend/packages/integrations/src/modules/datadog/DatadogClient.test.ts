import { describe, expect, it, vi } from 'vitest'
import { DatadogClient } from './DatadogClient.js'

// The monitor read is where the post-release-health gate decides whether a standing alert belongs
// to the release it is watching, so both halves of it are pinned: the query parameter without
// which Datadog populates no state at all, and the per-group timestamps it then returns.
describe('DatadogClient.getMonitor', () => {
  const creds = { site: 'datadoghq.com', apiKey: 'api', appKey: 'app' }

  function clientAnswering(body: unknown) {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return { urls, client: new DatadogClient(creds, { fetchImpl: fetchImpl as typeof fetch }) }
  }

  it('asks for group states, which is what makes a transition time answerable', async () => {
    const { urls, client } = clientAnswering({ name: 'p99', overall_state: 'OK' })

    await client.getMonitor('123')

    // Without `group_states`, `state` is absent from the response and the gate attributes every
    // standing alert to the release: "unknown" is deliberately read as "escalate".
    expect(urls[0]).toContain('/api/v1/monitor/123?group_states=all')
  })

  it('takes the LATEST trigger across groups, in epoch ms', async () => {
    const { client } = clientAnswering({
      name: 'errors',
      overall_state: 'Alert',
      state: {
        groups: {
          'host:a': { last_triggered_ts: 1_000 },
          'host:b': { last_triggered_ts: 4_000 },
          'host:c': {},
        },
      },
    })

    const monitor = await client.getMonitor('123')

    // One group triggering after the release marker makes the alert this release's, whatever the
    // others did earlier, so the latest wins rather than the first or the earliest.
    expect(monitor).toMatchObject({ overallState: 'Alert', stateModifiedMs: 4_000_000 })
  })

  it('reports no transition time when no group carries one', async () => {
    const { client } = clientAnswering({ overall_state: 'Alert', state: { groups: {} } })

    // Absent, not zero: the gate reads unknown as "investigate", and a 0 would read as an alert
    // older than every release.
    expect(await client.getMonitor('123')).not.toHaveProperty('stateModifiedMs')
  })
})

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

  it('takes the LATEST trigger across the groups that are still alerting, in epoch ms', async () => {
    const { client } = clientAnswering({
      name: 'errors',
      overall_state: 'Alert',
      state: {
        groups: {
          'host:a': { status: 'Alert', last_triggered_ts: 1_000 },
          'host:b': { status: 'Alert', last_triggered_ts: 4_000 },
          'host:c': { status: 'Alert' },
        },
      },
    })

    const monitor = await client.getMonitor('123')

    // One group triggering after the release marker makes the alert this release's, whatever the
    // others did earlier, so the latest wins rather than the first or the earliest.
    expect(monitor).toMatchObject({ overallState: 'Alert', stateModifiedMs: 4_000_000 })
  })

  it('ignores a group that has since recovered, however recently it triggered', async () => {
    const { client } = clientAnswering({
      name: 'errors',
      overall_state: 'Alert',
      state: {
        groups: {
          'host:standing': { status: 'Alert', last_triggered_ts: 1_000 },
          'host:blip': { status: 'OK', last_triggered_ts: 9_000 },
        },
      },
    })

    const monitor = await client.getMonitor('123')

    // `last_triggered_ts` survives the group recovering, so folding it over every group would let
    // a post-release blip that has already cleared hand the week-old standing alert on another
    // group to the release being watched.
    expect(monitor).toMatchObject({ stateModifiedMs: 1_000_000 })
  })

  it('reads a recovering group as still alerting, whatever the spelling', async () => {
    const { client } = clientAnswering({
      overall_state: 'Alert',
      state: { groups: { 'host:a': { status: 'Alert Recovery', last_triggered_ts: 2_000 } } },
    })

    // Datadog spells the same vocabulary with a space on a group and an underscore on the
    // monitor, and a group on its way back is still the alert the gate is looking at.
    expect(await client.getMonitor('123')).toMatchObject({ stateModifiedMs: 2_000_000 })
  })

  it('reports no transition time when only recovered groups carry one', async () => {
    const { client } = clientAnswering({
      overall_state: 'Alert',
      state: { groups: { 'host:a': { status: 'OK', last_triggered_ts: 5_000 } } },
    })

    // Unattributable, which the gate reads as "investigate". A monitor alerting overall while no
    // group says it is alerting is a response we cannot attribute, not an old alert.
    expect(await client.getMonitor('123')).not.toHaveProperty('stateModifiedMs')
  })

  it('reports no transition time when no group carries one', async () => {
    const { client } = clientAnswering({ overall_state: 'Alert', state: { groups: {} } })

    // Absent, not zero: the gate reads unknown as "investigate", and a 0 would read as an alert
    // older than every release.
    expect(await client.getMonitor('123')).not.toHaveProperty('stateModifiedMs')
  })
})

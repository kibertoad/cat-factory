import { describe, expect, it } from 'vitest'
import { CompositeNotificationChannel, type NotificationChannel } from '@cat-factory/kernel'
import type { AppConfig } from '@cat-factory/server'
import { buildNodeRealtimeDeps } from '../src/container-realtime-deps.js'
import { SystemClock } from '../src/runtime.js'

// The Node facade's mothership-side notification DELIVERY seam
// (docs/initiatives/mothership-mode.md, PR 4): a mothership serves
// `POST /internal/notifications/deliver` with its EXTERNAL channels (Slack + anything a downstream
// facade contributes) — never the in-app push, whose frame already reaches the mothership over the
// real-time upstream relay. This pins that split at its source, `buildNodeRealtimeDeps`, so the
// seam can't silently start double-pushing (or stop being wired). Pure unit coverage — the
// consensus wrap is off, so the heavy model/agent deps are never touched.

function channel(tag: string): NotificationChannel & { tag: string } {
  return { tag, async deliver() {} }
}

function build(opts: { extra?: NotificationChannel[]; realtime?: boolean } = {}) {
  const broadcast = () => {}
  return buildNodeRealtimeDeps({
    env: {},
    // Slack off (its own wiring is covered by the Slack specs); the external set is then exactly
    // what a downstream facade contributes — which is the local facade's mothership channel.
    // Email off too: the manager's builder reads `config.email` to decide whether to build the
    // email transport at all, and a fixture that omits a REQUIRED config section is testing a
    // shape the composition root can never be handed.
    config: {
      slack: { enabled: false },
      email: { enabled: false },
      agents: { routing: {} },
    } as unknown as AppConfig,
    repos: {} as never,
    sourced: (_name, buildRepo) => buildRepo(undefined as never),
    ...(opts.realtime ? { realtimeSink: { broadcast } } : {}),
    standardAgentExecutor: { tag: 'standard' } as never,
    modelProviderResolver: (() => {}) as never,
    resolveWorkspaceModelDefault: async () => undefined,
    agentKindRegistry: {} as never,
    // Required since the notification-webhook support joined this builder — the webhook's
    // signing path stamps its timestamps off the injected clock.
    clock: new SystemClock(),
    ...(opts.extra ? { extraNotificationChannels: opts.extra } : {}),
  })
}

describe('buildNodeRealtimeDeps notification channels (mothership delivery seam)', () => {
  it('wires no channel at all on a bare deployment (no realtime sink, no Slack, no extras)', () => {
    const deps = build()
    expect(deps.notificationChannel).toBeUndefined()
    // Nothing external ⇒ the ServerContainer leaves `machineNotificationDelivery` unset and
    // `POST /internal/notifications/deliver` 503s, which is the honest answer.
    expect(deps.externalNotificationChannel).toBeUndefined()
  })

  it('keeps the in-app push OUT of the external (mothership-delivered) set', () => {
    const deps = build({ realtime: true })
    // In-app is composed for this deployment's own browsers...
    expect(deps.notificationChannel).toBeDefined()
    // ...but must never be delivered on behalf of a mothership-mode node: that node's in-app frame
    // already arrives over `POST /internal/events/publish`, so delivering it here would double-push.
    expect(deps.externalNotificationChannel).toBeUndefined()
  })

  it('composes a contributed external channel into BOTH the local fan-out and the seam', () => {
    const extra = channel('remote')
    const deps = build({ extra: [extra] })
    expect(deps.externalNotificationChannel).toBe(extra)
    expect(deps.notificationChannel).toBe(extra)
  })

  it('fans out when the in-app push and a contributed channel are both present', () => {
    const extra = channel('remote')
    const deps = build({ realtime: true, extra: [extra] })
    expect(deps.notificationChannel).toBeInstanceOf(CompositeNotificationChannel)
    // The seam still carries the external channel ALONE, not the composite.
    expect(deps.externalNotificationChannel).toBe(extra)
  })
})

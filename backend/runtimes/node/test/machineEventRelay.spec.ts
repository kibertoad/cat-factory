import { describe, expect, it } from 'vitest'
import type { LocalEventSink } from '../src/realtime.js'
import { LocalMachineEventRelay } from '../src/machineEventRelay.js'

// The Node facade's mothership-side real-time UPSTREAM delivery: a relayed event from a
// mothership-mode node lands in this deployment's own fan-out via the LocalEventSink (the hub /
// layered propagator). Pure unit coverage — no Postgres, no network.

function recordingSink(): LocalEventSink & {
  calls: Array<{ workspaceId: string; payload: string; cid: string | null | undefined }>
} {
  const calls: Array<{ workspaceId: string; payload: string; cid: string | null | undefined }> = []
  return {
    calls,
    broadcast(workspaceId, payload, originConnectionId) {
      calls.push({ workspaceId, payload, cid: originConnectionId })
    },
  }
}

describe('LocalMachineEventRelay', () => {
  it('broadcasts a relayed event through the sink (payload + originConnectionId verbatim)', () => {
    const sink = recordingSink()
    new LocalMachineEventRelay(sink).ingest({
      workspaceId: 'ws_1',
      payload: '{"type":"board","reason":"x","at":1}',
      originConnectionId: 'cid_5',
    })
    expect(sink.calls).toEqual([
      { workspaceId: 'ws_1', payload: '{"type":"board","reason":"x","at":1}', cid: 'cid_5' },
    ])
  })

  it('normalises a missing originConnectionId to null', () => {
    const sink = recordingSink()
    new LocalMachineEventRelay(sink).ingest({ workspaceId: 'ws_1', payload: '{}' })
    expect(sink.calls[0]!.cid).toBeNull()
  })

  it('swallows a sink failure (best-effort delivery never throws)', () => {
    const relay = new LocalMachineEventRelay({
      broadcast() {
        throw new Error('hub closed')
      },
    })
    expect(() => relay.ingest({ workspaceId: 'ws_1', payload: '{}' })).not.toThrow()
  })
})

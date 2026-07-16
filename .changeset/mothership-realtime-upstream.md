---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

feat(mothership): real-time upstream publish (the outbound half of PR 2's real-time both directions)

A mothership-mode local node runs the engine on the laptop but delegates org/durable state to the
mothership. Until now its engine events (a run advancing, a board change, a notification) never
reached the mothership's real-time fan-out, so a hosted teammate watching the same shared board
couldn't see the local node's activity live. This adds the upstream channel.

- `@cat-factory/server`: a new machine-authed `POST /internal/events/publish` endpoint
  (`eventsRelayController`) + the `MachineEventRelay` seam on `ServerContainer` + the
  `HttpMachineEventClient`. Mounted on both facades; account-scoped and default-deny exactly like
  the persistence RPC (a workspace outside the token's scope is a uniform 404).
- `@cat-factory/node-server`: `LocalMachineEventRelay` delivers a relayed event into the facade's
  own real-time sink (the hub / layered propagator); attached whenever a realtime sink is wired.
- `@cat-factory/worker`: `DurableObjectMachineEventRelay` delivers a relayed event into the
  per-workspace `WorkspaceEventsHub` Durable Object — the symmetric Cloudflare side.
- `@cat-factory/local-server`: `MothershipWebSocketPropagator` (a `WebSocketPropagator` adapter,
  reusing the existing cross-node seam) forwards the local node's engine events upstream; it is
  layered over the hub in mothership mode so every event fans to the laptop's own SPA AND the
  mothership.

Scope: this is the OUTBOUND direction only. The INBOUND subscribe leg (the local node receiving org
events raised on the mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see
`docs/initiatives/mothership-mode.md`.

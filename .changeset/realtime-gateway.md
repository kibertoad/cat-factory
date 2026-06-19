---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Introduce the runtime "gateway" seam (`container.gateways`) and use it to make the
real-time event-stream controller runtime-neutral. `EventsController` moves into
`@cat-factory/server` and delegates the WebSocket upgrade to a `RealtimeGateway`
the facade supplies — on the Worker, `DoRealtimeGateway` forwards to the
per-workspace `WorkspaceEventsHub` Durable Object. This lets a non-Worker facade
provide its own real-time transport (e.g. a WebSocket hub) without touching the
controller. Behaviour on the Worker is unchanged.

---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Implement the real-time WebSocket transport on the Node + local facades, closing the
last "Worker-only" runtime gap for live board updates. Previously the SPA's
`ws://…/workspaces/:ws/events` handshake had no server on Node/local (the realtime
gateway returned null and `@hono/node-server` doesn't upgrade on its own), so the
browser logged a perpetual `connection refused` and only got updates by reconnect-time
snapshot refresh.

- New `runtimes/node/src/realtime.ts`: `NodeRealtimeHub` (in-memory per-workspace
  subscriber registry), `NodeEventPublisher` (mirrors the Worker's
  `DurableObjectEventPublisher` event shapes), and `attachRealtime` — a `ws` server bound
  to the HTTP `upgrade` event. The SPA speaks raw WebSocket (not socket.io), so the
  client is unchanged across runtimes; `@hono/node-ws` was rejected because its
  `upgradeWebSocket` middleware can't compose with the shared, `Response`-returning
  `EventsController`.
- `start()` creates the hub, wires it into `buildNodeContainer` (as the engine's
  `executionEventPublisher`, decorated with `FanOutEventPublisher` so a shared service's
  events reach every mounting board, plus an `InAppNotificationChannel` composed
  alongside Slack), and attaches it to the HTTP listener. Local mode inherits all of
  this through `buildLocalContainer`'s pass-through, so a developer running locally now
  gets live execution/bootstrap/notification updates.
- Ticket mint/verify is extracted into the shared `@cat-factory/server`
  `auth/wsTicket.ts` (`mintWsTicket`/`authorizeWsUpgrade`), used by both the Worker's
  `EventsController` and the Node upgrade handler so both handshakes authorise
  identically. `InAppNotificationChannel` is promoted from the Worker into
  `@cat-factory/server` so both facades deliver in-app notifications through one class.

Single-process only for now: a multi-replica Node deployment would need a shared bus
(Postgres `LISTEN/NOTIFY`) in front of the in-memory hub. The Worker's behaviour is
unchanged (it gains the shared ticket/channel helpers).

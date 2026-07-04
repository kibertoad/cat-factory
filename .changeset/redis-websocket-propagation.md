---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Cross-node WebSocket propagation for the Node facade (optional Redis adapter).

The Node facade's real-time transport (`NodeRealtimeHub`) is an in-process, single-node socket
registry: an event published on the node that processed a run only reaches browsers connected to
THAT node. A horizontally-scaled Node deployment spreads browsers and background work across
several nodes, so an event produced on one node has to reach a browser attached to another.

This adds that reach as a **layered propagator** with pluggable cross-node adapters. Publishing an
event fans it to the local hub AND to each configured adapter; an adapter carries it to peer nodes,
which apply it to their own local hubs. **Redis pub/sub is the first adapter** — a Postgres
LISTEN/NOTIFY or NATS adapter would implement the same `WebSocketPropagator` port with no other
changes.

- `ioredis` is an **optional dependency**, imported dynamically only when `REDIS_URL` is set. With
  no bus configured (single-replica Node, and **local mode**, which is always single-node) the
  layer is exactly the bare hub with zero overhead and no extra dependency — the default.
- Config: `REDIS_URL` enables it; `REDIS_REALTIME_CHANNEL` (default `cat-factory:realtime`) and
  `REALTIME_NODE_ID` (default a random uuid, used to drop a node's own echoes) tune it.
- The engine's event publisher now writes through a narrow `LocalEventSink` seam that both the bare
  hub and the layered propagator implement, so no other code differs between single- and multi-node.

The Worker facade needs none of this: its real-time transport is a globally-addressed
`WorkspaceEventsHub` Durable Object (one per workspace across the whole deployment), so cross-node
propagation is inherent to the platform — this is a genuine Node-only concern, not a facade gap.

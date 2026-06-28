---
"@cat-factory/kernel": patch
"@cat-factory/orchestration": patch
"@cat-factory/server": patch
"@cat-factory/worker": patch
"@cat-factory/node-server": patch
"@cat-factory/app": patch
---

Suppress the real-time self-echo for board moves/reparents so dragging a task several
times in quick succession is reliable. The SPA now tags every request with a stable
per-tab connection id (`X-Connection-Id`) and the realtime WebSocket connect with the
matching `?cid=`; the board `move`/`reparent` controllers forward it through
`BoardService` to `boardChanged`, and both realtime hubs (the Cloudflare
`WorkspaceEventsHub` Durable Object and the Node `NodeRealtimeHub`) skip delivering the
coarse `board` event back to the connection that caused it. The originating client keeps
its optimistic state plus its own authoritative REST response instead of refreshing off
its own move (a mid-flight snapshot of which carried a stale position, snapping the block
back). Other subscribers still receive the event and refresh.

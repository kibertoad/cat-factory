---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': patch
'@cat-factory/app': minor
---

Live model-activity: push per-call LLM activity over the workspace event stream.

The "Model activity" panel fetched once when it opened and never updated, so a running
step's calls only appeared on a manual reopen — and when a durable driver was evicted
mid-run the board badge (which rides the poll loop) froze too, making a stalled driver
look identical to a wedged agent. But the proxy records every call the moment it
returns, independent of the execution driver, so the data was live the whole time;
only the read side was stale.

The proxy now emits a compact `llmCall` event per model call, sourced where the metric
is already recorded:

- New `LlmCallActivity` contract + `llmCall` `WorkspaceEvent` variant — the per-call
  summary (id, run, agent kind, provider/model, tokens, finish reason, ok/status, the
  latency split) WITHOUT the prompt/response bodies, so the stream payload stays small.
- `ExecutionEventPublisher` gains an optional `llmCallObserved`; the proxy mints the
  call id (so the live row and the persisted metric share it) and pushes through the
  same realtime publisher execution events use. `DurableObjectEventPublisher` fans it
  to the `WorkspaceEventsHub` on Cloudflare; `FanOutEventPublisher` forwards it; Node's
  no-op publisher leaves it inert until Node gains a real-time transport. The emit is
  best-effort and fires even when the persistence sink is off.
- SPA: `useWorkspaceStream` folds the event into the observability store, so an open
  panel updates in real time and keeps updating during a driver eviction. Live-appended
  rows carry no bodies; the panel lazy-loads those (by id) from the persisted metrics
  endpoint when a row is expanded.

Both runtimes' real Hono apps are covered by a proxy-emit integration test asserting
the identical compact activity event (Cloudflare over the DO publisher path, Node over
its app), so the live stream can't silently work on one runtime and not the other.

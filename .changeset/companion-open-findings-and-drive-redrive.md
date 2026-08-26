---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Carry a companion's unanswered findings to the next producer, stop counting a spend correction as an LLM call, and stop an exponential backoff from stalling a live run.

A companion loop does not only end because the work is clean. Past its first forced round a `major` no longer holds the run, and a person may approve over a `blocker`, so the last verdict's points can be real, unanswered and on the record while the run walks straight past them. Those points now ride the reviewed step's `priorOutputs` entry and reach every later step under the artifact they are about, worded so they cannot read as already handled. Earlier rounds are excluded on purpose: each of those was answered.

`llm_call_metrics` gains `spend_only`. A harness CLI costs each turn's input but leaves its output at the message-start snapshot, so the producer files the shortfall as its own row rather than inflating a measured turn. That row is real spend and is not a call, and `COUNT(*) AS calls` was counting it: one phantom call per dispatch on every subscription-harness step. Token sums are unchanged; call counts drop the row.

All four Node drive queues now enqueue through one options builder with `retryBackoff: false`. A drive job mostly fails because the worker went away, which the next attempt succeeds at, and nothing else can shorten the delay: the stale-run sweeper reads a `retry`-state job as live and the exclusive singleton no-ops a fresh send.

The default companion rework budget goes from 3 to 4, on every shipped preset including the unattended one.

BREAKING (internal): the LOCAL SQLite telemetry store creates its schema with `CREATE TABLE IF NOT EXISTS` and has no column-migration path, so an existing local telemetry database will reject metric inserts on the new `spend_only` column until it is deleted and re-created. Telemetry writes are best-effort, so runs are unaffected. The D1 and Postgres stores migrate normally.

---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/executor-harness': patch
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Carry a companion's unanswered findings to the next producer, stop counting a spend correction as an LLM call, and stop an exponential backoff from stalling a live run.

A companion loop does not only end because the work is clean. Past its first forced round a `major` no longer holds the run, and a person may approve over a `blocker`, so the last verdict's points can be real, unanswered and on the record while the run walks straight past them. Those points now ride the reviewed step's `priorOutputs` entry and reach every later step under the artifact they are about, worded so they cannot read as already handled. Earlier rounds are excluded on purpose: each of those was answered.

`llm_call_metrics` gains `spend_only`. A harness CLI costs each turn's input but leaves its output at the message-start snapshot, so the producer files the shortfall as its own row rather than inflating a measured turn. That row is real spend and is not a call, and `COUNT(*) AS calls` was counting it: one phantom call per dispatch on every subscription-harness step. Token sums are unchanged; call counts drop the row, and so do the `turns_after` windows behind the carry cost, which charged every real turn one carry too many for it.

Which of the two a shortfall row is stays with the PRODUCER, on both paths: it is a spend correction when measured turns were filed beside it and the job's only call record when none were. The container harness states that on the metric (a new `spendOnly`, hence the image bump) rather than leaving the backend to infer it from `standsForJob`, which would have reported every un-narrated container run as zero calls with real spend, or from the batch it was handed, which the live drain splits across polls.

All four Node drive queues now enqueue through one options builder with `retryBackoff: false`. A drive job mostly fails because the worker went away, which the next attempt succeeds at, and nothing else can shorten the delay: the stale-run sweeper reads a `retry`-state job as live and the exclusive singleton no-ops a fresh send.

The default companion rework budget goes from 3 to 4, on every shipped preset including the unattended one.

Opening a LOCAL `node:sqlite` store now reconciles the file's columns against the schema it was handed, adding the ones it is missing. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so every column added to a shipped schema (`phase`, `turn_index` and now `spend_only`, all on `llm_call_metrics`) reached a fresh database and no other, and an existing file then failed both the inserts and the reads naming it: `summarizeByExecution` backs the live board rollups, so the damage was never confined to the write side. The reconciliation is additive only, and refuses to open on a column SQLite cannot add rather than serving a store that fails one query at a time. D1 and Postgres migrate as before.

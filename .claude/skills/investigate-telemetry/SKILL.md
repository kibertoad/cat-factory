---
name: investigate-telemetry
description: Investigate a failed or suspicious agent run (implementer/coder, bootstrap, reviewer, etc.) using the production telemetry in D1. Use when asked to look into a run failure, "no progress" abort, a stuck/looping agent, model output quality, token/truncation issues, or "what went wrong with the latest run". Pulls the run lifecycle from `agent_runs` and the per-LLM-call prompt/response/usage from `llm_call_metrics`, then reads the tool-call loop to find the root cause.
---

# Investigate run telemetry (from D1)

Telemetry lives in the production D1 database `cat_factory`, NOT (primarily) in
Cloudflare Workers Observability. Two tables carry everything you need:

- **`agent_runs`** — one row per container-backed run (`kind='execution'` for the
  task pipeline / implementer, `kind='bootstrap'` for repo bootstrap). Holds
  `status`, the structured `failure` JSON (kind/message/hint/lastSubtasks), and a
  `detail` JSON with every pipeline step (agentKind, state, model, approvals,
  per-step `metrics`). This is the lifecycle + the failure verdict.
- **`llm_call_metrics`** — one row per LLM call (migration 0026). Holds
  `agent_kind`, `provider`, `model`, `ok`, `http_status`, `finish_reason`,
  token counts, `request_max_tokens`, the latency split (`upstream_ms`/`overhead_ms`),
  `error_message`, and the full `prompt_text` + `response_text`. Linked to a run by
  `execution_id`. This is what the model actually saw and produced.

  Three producers write here and their rows read differently, so check which one you have
  before drawing a conclusion from a null: a **proxied** container call (Pi) carries the full
  latency split and an `http_status`; a **subscription harness** call (Claude Code / Codex)
  carries a `turn_index` and a `phase` but zero timing (the CLIs expose none); an **inline**
  call (a judge, consensus, the requirements writer, an inline agent kind such as
  `doc-researcher` / `doc-outliner` / the document interviewer) has `streaming=0`,
  `turn_index` NULL, `http_status` NULL, `phase=''`, and `upstream_ms = total_ms` — a genuine
  0 overhead, because there is no proxy hop. None of those nulls means data was lost.

Retention: `llm_call_metrics` is pruned to `LLM_CALL_METRICS_RETENTION_DAYS` (default 14
days) because the full bodies are heavy; `agent_runs` lives longer. A deployment may have
lowered it, so an empty result for an older run can mean pruned rather than never recorded.

## How to query

Run wrangler from `deploy/backend` (its `wrangler.toml` defines the `cat_factory`
binding). Always pass `--remote` (production) and `--json` (parseable). Do NOT
pre-check Cloudflare auth — assume the login is correct (see CLAUDE.md).

```bash
cd deploy/backend
npx wrangler d1 execute cat_factory --remote --json --command "SELECT ..."
```

Parse the JSON with `node -e` (Python is not on PATH here). The result shape is
`[{ results: [...rows], success, meta }]`.

## Step 1 — find the run

Latest implementer/pipeline runs (drop the `WHERE kind` to see bootstrap too):

```sql
SELECT id, kind, status, block_id,
       datetime(created_at/1000,'unixepoch') AS created,
       datetime(updated_at/1000,'unixepoch') AS updated
FROM agent_runs
WHERE kind='execution'
ORDER BY created_at DESC LIMIT 10;
```

Take the `id` (e.g. `exec_44c8387cac02`) of the run in question.

## Step 2 — read the failure verdict and step list

```sql
SELECT failure, detail FROM agent_runs WHERE id='<run id>';
```

- `failure` (JSON): `kind` (`job_failed`, `evicted`, `timeout`, `agent`, …),
  `message` (the abort reason — e.g. the `ProgressGuard` text), `hint`, and
  `lastSubtasks`. This tells you HOW the run died.
- `detail.steps[]` (JSON): which step was running at failure (`state:'working'`),
  the `model` each step used, and each step's rolled-up `metrics`
  (`calls`, `truncatedCalls`, `errors`, `warnings`, `peakCompletionTokens`,
  `maxOutputTokens`). The step with `jobId === <run id>` is the container step.

## Step 3 — read the per-call LLM telemetry

Overview of every call for the failing step's kind (usually `coder`):

```sql
SELECT agent_kind, provider, model, ok, http_status, finish_reason,
       prompt_tokens, completion_tokens, request_max_tokens, upstream_ms,
       datetime(created_at/1000,'unixepoch') AS t, substr(error_message,1,300) AS err
FROM llm_call_metrics
WHERE execution_id='<run id>' AND agent_kind='coder'
ORDER BY created_at ASC;
```

Read the columns as signals:

- `ok=0` / non-2xx `http_status` / non-null `error_message` → transport, proxy, or
  spend-gate failure (an infra problem, not a model problem).
- `finish_reason='length'` or `completion_tokens` near `request_max_tokens` →
  output truncation; the model was cut off mid-answer (raise the output limit or
  shrink the task). `truncatedCalls` in the step metrics counts these.
- `ok=1` + `finish_reason='tool_calls'` everywhere → the LLM side is healthy; the
  failure is in tool EXECUTION inside the container (see step 4). Not in this table,
  but each failing tool call is its own row in `agent_tool_calls` (`ok=0`), which is
  where step 4 starts. The `ProgressGuard` (harness `pi.ts`) counts the same failures
  live off Pi's event stream, which is what aborts the run.

## Step 4 — read the actual tool-call loop (the root cause)

Read the trajectory first. `agent_tool_calls` (same telemetry DB) holds one row per tool
invocation, so a stuck loop or a failing edit is visible without reconstructing it from
prompt deltas:

```sql
SELECT seq, tool, ok, datetime(started_at/1000,'unixepoch') AS t,
       substr(args,1,200) AS args, substr(result,1,300) AS result
FROM agent_tool_calls
WHERE execution_id='<run id>'
ORDER BY started_at ASC, seq ASC;
```

Order by `(started_at, seq)`, never by `job_id` (a string that sorts a run's dispatches by
agent-kind spelling) and never by `seq` alone (it restarts at zero on each dispatch). Add
`AND job_id='<job id>'` to read one dispatch. `bodies='withheld'` means the workspace or
deployment opted out of body capture, so an empty `args` says nothing about the call; a run
whose image predates the sink has no rows at all, and the deltas below are then the only
account.

`prompt_text` is stored as a DELTA vs the previous call (migration 0027), so each
call's `prompt_text` contains the new assistant message(s) plus the tool RESULT
messages returned to the model — including tool validation errors. `response_text`
is the model's text content (tool-call arguments are echoed inside the assistant
message in the next call's prompt delta).

Dump responses to see what the model was trying to do:

```sql
SELECT completion_tokens, response_text
FROM llm_call_metrics
WHERE execution_id='<run id>' AND agent_kind='coder'
ORDER BY created_at ASC;
```

Dump the tail of the final prompt to see the last tool result/error the model got:

```sql
SELECT prompt_text FROM llm_call_metrics
WHERE execution_id='<run id>' AND agent_kind='coder'
ORDER BY created_at DESC LIMIT 1;
```

Look for, in `prompt_text`: `Validation failed for tool "<tool>"` /
`must have required properties <field>` (the model is emitting malformed tool
args), repeated identical tool calls (a stuck loop), or `<tool_call>…</tool_call>`
appearing as literal TEXT in `response_text` (the model emitted a tool call as
prose instead of through the structured channel — fragile parsing, a model-quality
smell). In `response_text`: garbled token-soup completions point at a Workers AI
decode bug for that model (cf. the streaming token-doubling fix, commit 23b9fb6).

## Step 5 — classify and report

Decide whether the failure is:

- **Model quality** — malformed/looping tool calls, garbled output, ignored
  validation errors. Fix: don't default that role to that model; pin a stronger
  tool-calling model or denylist it for code steps.
- **Truncation** — `finish_reason='length'`. Fix: raise output limit / split task.
- **Infra** — `ok=0`, HTTP errors, spend-gate refusals, eviction/timeout
  (`failure.kind`). Fix: the proxy/runner/budget, not the prompt.
- **Working as designed** — the `ProgressGuard` aborting a genuinely stuck run is
  the safety net doing its job; the bug (if any) is upstream of it.

Report: the run id, the failing step + model, the abort reason, the root-cause
class with the evidence (quote the specific tool error or response), and a concrete
fix. Then the run can be retried (`POST /workspaces/:ws/agent-runs/:id/retry`,
or the board "retry" button) to spin a fresh container.

## Notes

- Helper one-liner to scan all deltas for tool validation failures:
  pipe the `prompt_text` rows through `node` and
  `match(/must have required properties (\w+)/g)`.
- The app also exposes this without SQL:
  `GET /executions/:id/llm-metrics` (per-call list) and
  `GET /executions/:id/llm-metrics/export` (LLM-friendly JSON bundle). With a
  `read`-scoped public API key, the remote debugging surface (`/api/v1/debug/*`,
  see `backend/docs/debug-api.md`) covers steps 1–4 end to end: the run
  overview's `signals` replace step 2's manual reading, and
  `?contains=` + `matchOffset` + `?bodyOffset=` replace step 4's grep. Use D1
  directly when you need cross-run queries or the app is unreachable.

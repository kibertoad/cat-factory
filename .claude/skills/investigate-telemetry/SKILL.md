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
- **`llm_call_metrics`** — one row per proxied LLM call (migration 0026). Holds
  `agent_kind`, `provider`, `model`, `ok`, `http_status`, `finish_reason`,
  token counts, `request_max_tokens`, the latency split (`upstream_ms`/`overhead_ms`),
  `error_message`, and the full `prompt_text` + `response_text`. Linked to a run by
  `execution_id`. This is what the model actually saw and produced.

Retention: `llm_call_metrics` is pruned aggressively (default 3 days,
`LLM_CALL_METRICS_RETENTION_DAYS`) because the full bodies are heavy; `agent_runs`
lives longer. Investigate recent runs promptly.

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
  failure is in tool EXECUTION inside the container (see step 4). The
  `ProgressGuard` (harness `pi.ts`) counts failing tool calls from Pi's event
  stream — those tool errors are NOT rows here, only the LLM calls that drove them.

## Step 4 — read the actual tool-call loop (the root cause)

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
  `GET /executions/:id/llm-metrics/export` (LLM-friendly JSON bundle). Use D1
  directly when you need cross-run queries or the app is unreachable.

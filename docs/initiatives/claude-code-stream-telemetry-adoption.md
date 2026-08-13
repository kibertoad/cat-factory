# Initiative: adopt the Claude Code stream's telemetry surface

**Status:** in progress (Slice 1 next) · **Owner:** core · **Started:** 2026-08-13

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The harness reads three event types off `claude --output-format stream-json --verbose`:
`assistant`, `user` and the terminal `result` (`agent-runner.ts`, the `onEvent` dispatch), plus
the `system`/`init` event for MCP status (`agent-capabilities.ts`). The CLI emits considerably
more than that, and the gap has widened with every image bump because nothing tells us when the
vendor adds a field: the stream is a contract we read a fixed subset of and never re-survey.

A survey against the CLI the image actually pins found the harness is **reconstructing, from the
`assistant` envelopes alone, several numbers the CLI now states outright**, and is missing a
per-subagent accounting channel that needs no file watching. It also found one measured
under-count that the 2.1.229 bump introduced (see below).

This tracker is the re-survey plus the adoption work. It is deliberately scoped to what the
stream already carries: nothing here needs a new port, a new table or a vendor request.

### Why this is not a cosmetic upgrade

Two of the signals close defects that are live today:

1. **Subagent spend is recorded by neither channel on an `ambientAuth` run.** Measured, not
   inferred. See "The 2.1.229 regression" below.
2. **Reasoning tokens are billed as output and are invisible in our per-class split.** The
   sibling [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) made
   the input side honest (fresh / read / write). The output side is still one lump, and the CLI
   now reports the thinking share of it.

## How the survey was taken (repeat this on every image bump)

Reproducible, and cheap enough to be a habit rather than a project:

1. `npm pack @anthropic-ai/claude-code@<old> @anthropic-ai/claude-code@<new>` into a scratch dir
   and `diff` the shipped `sdk-tools.d.ts`. That file is the tool input/output schema and is the
   only machine-readable half of the contract the package ships.
2. Run one headless probe that dispatches a subagent, with the pinned CLI version, and dump every
   event's `type` / `subtype` / top-level keys. The tool schema does not describe the stream
   ENVELOPE, so the diff alone will not show a new event type.
3. Reconcile the per-call numbers against the terminal `result`, as "Verified accounting" does
   below. A silent change in what an aggregate covers is the failure mode that a schema diff
   structurally cannot catch.

Survey of record: CLI `2.1.229`, taken 2026-08-13, against the range `2.1.207 → 2.1.221 →
2.1.226 → 2.1.229` (`2.1.207` being the version the ADR 0026 / 0027 comments were written
against).

## The 2.1.229 regression (fix in Slice 1)

`--forward-subagent-text` landed in CLI `2.1.211`, and with it **subagent assistant turns stopped
crossing the parent stream by default**. Same prompt, same build, one subagent dispatched:

| invocation                                | events tagged with `parent_tool_use_id`               |
| ----------------------------------------- | ----------------------------------------------------- |
| no flag (what the harness passes today)   | 1, a `user` text event carrying no `usage`            |
| `--forward-subagent-text`                 | 3, including `assistant` turns carrying per-turn usage |

`createSubagentStreamTelemetry` (`claude-stream.ts`) mints a per-dispatch conversation only on an
`assistant` envelope, and drops a `tool_result` for a dispatch it has never seen. So on `2.1.229`
that fallback cannot record a single call. It matters only where it is the sole channel, which is
exactly the case it was built for: an `ambientAuth` run has no isolated config home, so no
`subagents/*.jsonl` watcher runs, and its subagent spend is now recorded by **nobody**.

Do not "fix" this by deleting the fallback as dead code. It is not dead, it is starved, and an
under-count reads as a cheap run rather than as an error (the ADR 0027 lesson, restated).

**The container path is unaffected.** Verified on the same build: the CLI still writes
`<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl`, so the watcher path
that ADR 0027 Defect A corrected is intact.

## Verified accounting (do not re-derive this by guessing)

The invariant `assembleClaudeOutcome` asserts (parent `result.usage` and the subagents' usage are
DISJOINT, so the run total is their sum) **holds**, and now has a measurement behind it. One run,
one subagent, both cache buckets reconcile exactly against the CLI's own per-model rollup:

```
cache_creation:  parent  3112 + subagent  2118 =  5230  = modelUsage.cacheCreationInputTokens
cache_read:      parent 54973 + subagent 13305 = 68278  = modelUsage.cacheReadInputTokens
```

The corollary is the part to carry forward: **`modelUsage` and `total_cost_usd` are strictly
larger than parent + subagents.** In the same run `modelUsage.inputTokens` was 588 against a
parent + subagent sum of 30, because the CLI also bills its own internal calls (session titling
and similar) to the same model. So our summed per-call telemetry will always under-report the
CLI's cost figure, and that difference is real spend rather than a counting defect. Anyone
reconciling the two surfaces will hit this and file it as a bug unless it is written down.

## Signal inventory

Everything below is on the parent stream of the pinned CLI. "Read today" is what the harness does
now, not what it could do.

| Event                       | Fields worth having                                                                                                                                                | Read today | What it unlocks                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| `user` → `tool_use_result`  | The structured `AgentOutput`: full `usage` with cache breakdown and `output_tokens_details.thinking_tokens`, `resolvedModel`, `totalToolUseCount`, `totalDurationMs`, `toolStats` (read / search / bash / edit counts, `linesAdded`, `linesRemoved`) | no         | Authoritative per-subagent telemetry with NO watcher and NO isolated config home. Fixes the regression above on both paths. |
| `system` / `task_notification` | Per-subagent `usage {total_tokens, tool_uses, duration_ms}`, `status`, `output_file`, `summary`, keyed by `tool_use_id`                                          | no         | A second, cheaper subagent accounting channel; `status` settles a slice without waiting on the paired `tool_result`. |
| `result`                    | `total_cost_usd`, `modelUsage` (per model: token classes, `costUSD`, `contextWindow`, `canonicalModel`, `provider`), `permission_denials`, `terminal_reason`, `num_turns`, `duration_api_ms`, `ttft_ms` | `result` text + input/output tokens only | A ground-truth cost number to reconcile burn against; `permission_denials` names a capability the agent was refused. |
| `rate_limit_event`          | `rate_limit_info {status, rateLimitType, resetsAt, overageStatus, overageDisabledReason, isUsingOverage}`                                                          | no         | Subscription throttling stated rather than inferred from a failure. Feeds [`usage-and-quota-tracking`](./usage-and-quota-tracking.md). |
| `system` / `thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta`                                                                                                                       | no         | An activity signal during extended thinking, the one phase that is otherwise silent to the inactivity watchdog. |
| `system` / `task_started`   | `subagent_type`, `task_type`, `description`, and the subagent's full `prompt`                                                                                       | no         | A real seed for a subagent's reconstructed conversation. `claude-call-aggregator.ts` currently asserts this prompt never crosses the stream, which stopped being true. |
| `system` / `init`           | `mcp_server_errors` (CLI `2.1.219`), `claude_code_version`, `agents`, `skills`, `capabilities`, `memory_paths`, `apiKeySource`                                      | `mcp_servers` + `tools` only | `mcp_server_errors` names servers SKIPPED by config validation, which by construction never appear in `mcp_servers`, so a misconfigured server is invisible today. |
| `assistant`                 | `uuid`, `request_id`                                                                                                                                                | no         | Correlation with the CLI's own OTel attributes (`message.uuid`, `client_request_id`, added `2.1.214`). |

Genuinely new in `2.1.229` (the `2.1.226 → 2.1.229` schema diff) is only
`output_tokens_details.thinking_tokens`. Everything else above has been available for several
image bumps and was simply never surveyed, which is the habit this tracker's step 1 to 3 recipe
exists to end.

## End state

- Subagent spend is recorded on every auth mode, from a channel that does not depend on a file
  layout the vendor has already moved once.
- The output token class is split into reasoning and answer, matching the honesty the input side
  already has.
- A run's telemetry carries the CLI's own `total_cost_usd` beside our summed figure, with the
  difference explained rather than reconciled away.
- The stream survey is a step in the image-bump checklist, so the next added field is found by
  process rather than by an investigation.

## Per-slice checklist

| #   | Slice                          | Scope                                                                                                                        | Status  | PR  |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 0   | Survey + tracker               | Diff the shipped schema across `2.1.207 → 2.1.229`, probe the live stream, record the inventory and the verified accounting  | ✅ done |     |
| 1   | Subagent spend on every path   | Read `tool_use_result` as the subagent channel; decide the watcher's fate; assert an ambient run records its subagent calls   | ⬜ todo |     |
| 2   | Reasoning tokens as a class    | `thinking_tokens` onto the call metric and both telemetry stores; split the output lump in the rollups and the panel          | ⬜ todo |     |
| 3   | CLI cost beside ours           | `total_cost_usd` / `modelUsage` onto the run outcome, with the internal-call difference STATED, never silently reconciled     | ⬜ todo |     |
| 4   | Rate-limit + capability truth  | `rate_limit_event` onto subscription tracking; `mcp_server_errors` into the observed-capability record; `permission_denials`  | ⬜ todo |     |
| 5   | Thinking as activity           | Feed `system`/`thinking_tokens` to the inactivity heartbeat                                                                  | ⬜ todo |     |
| 6   | Survey in the bump checklist   | Fold the recipe above into the image-bump procedure so the next field is found by process                                     | ⬜ todo |     |

## Conventions / gotchas carried between iterations

- **The stream envelope is not in the shipped schema.** `sdk-tools.d.ts` describes tool inputs and
  outputs. A new `system` subtype, a new top-level event, a new field on `result`: none of them
  show up in a schema diff. Only a live probe finds those, which is why the recipe has both halves.
- **A vendor flag can silently retire a channel we depend on.** `--forward-subagent-text` did not
  break anything loudly; it turned a working fallback into one that cannot fire. When a channel is
  best-effort, the test that protects it must assert it produced SOMETHING on the path where it is
  the only channel, not merely that the parser handles the shape.
- **Prefer the field the CLI states over the number we reconstruct.** Every reconstruction here
  (per-call folding, subagent transcript tailing) exists because the stated field did not exist
  when it was written. Check before adding another.
- **An aggregate's COVERAGE is part of its contract.** `result.usage` covers the parent loop;
  `modelUsage` covers the parent, the subagents and the CLI's internal calls. They differ by real
  spend, not by error. Record which one a number came from wherever both are in play.
- **`toolStats` is not `PiRunStats`.** The CLI's per-subagent counts describe what that subagent
  did; `PiRunStats` answers "did the agent act at all" for the whole run (`agentNeverActed`) and is
  accumulated off the raw stream on purpose. Adding the former to the latter would make the same
  run report different activity depending on which channel billed it (the ADR 0027 lesson).
- **A capability the CLI skipped is not a capability the CLI reports.** `mcp_servers` lists what
  loaded. `mcp_server_errors` lists what did not. Reading only the first is how "this run wired
  none" and "this run's servers were all rejected" collapse into the same record.

## Siblings

- [`token-burn-instrumentation`](./token-burn-instrumentation.md): the instrument this feeds.
  Slice 3 here supplies the ground-truth cost its baseline slice needs.
- [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md): made the input
  side honest; Slice 2 here is the same move for the output side.
- [`usage-and-quota-tracking`](./usage-and-quota-tracking.md): the consumer of
  `rate_limit_event`.
- [`stuck-run-audit`](./stuck-run-audit.md): Slice 5's heartbeat signal is one of its cases.

Reference docs, not trackers: [`llm-telemetry.md`](../../backend/docs/llm-telemetry.md) is the
authority for anything recording an LLM call, and
[ADR 0026](../../backend/docs/adr/0026-pr-review-observability-and-pool-isolation.md) /
[ADR 0027](../../backend/docs/adr/0027-pr-review-observability-followup.md) are why the subagent
watcher exists and where its path was corrected.

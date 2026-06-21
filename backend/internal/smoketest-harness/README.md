# @cat-factory/smoketest-harness

A standalone, headless harness that runs **real coding tasks** through cat-factory's
**actual Pi coding-agent setup** and captures the whole run for analysis. Unlike the
[benchmark harness](../benchmark-harness/README.md) it **does not grade anything** —
it answers a different question:

> Can this model actually do the work through our Pi harness, and _where does it get
> stuck_?

For every case it captures the **complete prompt/response/tool-call transcript** and
analyses it for:

- **Breakage** — the model is unusable: Pi can't run, the model went unreachable and
  exhausted retries, or it produced nothing at all (no-op).
- **Dead-ends** — the agent stopped making progress: killed by the no-progress guard,
  hit the watchdog, or ran without ever landing a file change.
- **Non-productive loops** — repeated identical tool calls, thrashing on a failing
  operation, a web-search rabbit-hole, lots of motion with a near-empty diff.

It reuses as much as possible: the **same Pi flow** as the runtime (clone → write the
build system prompt to Pi's global `AGENTS.md` → run Pi against the OpenAI-compatible
endpoint) via `@cat-factory/executor-harness`, and the model/endpoint/prompt resolution
from `@cat-factory/benchmark-harness`. The only addition to the shared Pi driver is an
`onEvent` observer on `runPi`, so the harness sees the full event stream without
re-implementing anything.

## Local + Cloudflare AI

Like the benchmark harness, this runs **locally** while using **actual Cloudflare
Workers AI**: `workers-ai` models are reached over the Cloudflare REST OpenAI-compatible
endpoint (`CF_ACCOUNT_ID` + `CF_API_TOKEN`), which is also what Pi is pointed at. It is
**not** run in CI — it needs a configured Cloudflare account and the `pi` CLI.

## Usage

```bash
# Copy + edit the matrix
cp backend/internal/smoketest-harness/smoke.config.example.ts \
   backend/internal/smoketest-harness/smoke.config.ts

# Run → docs/smoketests/<run-id>/
pnpm --filter @cat-factory/smoketest-harness smoke -- \
  run --config <abs-path-to>/smoke.config.ts --name my-run
```

Flags: `--fixture <id>` (one task), `--name <id>`, `--out <dir>`, `--relax-guard`
(let a loop run to completion instead of being killed by the guard, to capture it whole).

## Output

Under `docs/smoketests/<run-id>/`:

- `report.md` — the at-a-glance table (verdict + findings per case) and "what to look at
  first".
- `results.json` / `manifest.json` — machine-readable results + run summary.
- `cases/<case-id>/`:
  - `analysis.md` — verdict, findings, metrics, the agent's summary.
  - `transcript.jsonl` — **the raw capture**: every Pi event, including the full final
    transcript (all prompts + responses).
  - `transcript.md` — a rendered, skimmable conversation.
  - `prompt.md` — the exact system + user prompt the agent was given.
  - `diff.patch` — what the run changed (may be empty / partial).

The run exits non-zero if any case is `broken`.

## Environment

| Var                                                                         | Needed for                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN`                                             | Cloudflare Workers AI (local), via REST and as the Pi endpoint |
| `OPENAI_API_KEY` / `QWEN_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` | a direct-provider candidate, if used                           |
| `GH_TOKEN`                                                                  | cloning a private fixture repo (optional for public repos)     |
| `pi` CLI on PATH                                                            | running the agent                                              |

The no-progress guard bounds are the same env-configurable ones the runtime uses
(`JOB_MAX_TOOLCALLS_WITHOUT_EDIT`, `JOB_MAX_CONSECUTIVE_TOOL_ERRORS`,
`JOB_MAX_CONSECUTIVE_WEB_CALLS`); `--relax-guard` overrides them for a run.

## Fixtures

Built-in coding tasks live in `src/fixtures.ts` (add a `/health` endpoint + test,
add a tested helper, scaffold a tiny service). They target small, public, stable repos
and are deliberately moderate. Point a fixture at your own repo by editing the config's
`fixtures` and the fixture definition when you want to smoketest a specific codebase.

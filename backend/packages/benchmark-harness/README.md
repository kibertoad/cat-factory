# @cat-factory/benchmark-harness

A standalone, headless harness for benchmarking cat-factory's agents across
**models** and **prompt versions**, on three tasks:

- **requirement review** — the stateless reviewer (`requirementsLogic` from core)
- **code review** — the `reviewer` agent (`AiAgentExecutor`, standard `review` phase)
- **implementation** — the _real_ Pi coding flow (reused from `@cat-factory/implementer-harness`): clone a repo, run Pi, capture the diff

It reuses the **exact same agents and prompts** as the runtime, made embeddable
outside the Worker/container. Outputs are graded by the Claude **benchmark-arbiter**
skill (your Claude subscription — no API key), and committed under
`docs/benchmarks/<run-id>/`.

## Why

Optimised for **switching models and prompts trivially** to measure impact: the
matrix is a single config file, and every result records the **exact
`provider:model`** and **exact prompt version** (`id@vN`) that produced it.

## Local + Cloudflare AI

The `NodeModelProvider` is the Node twin of the Worker's `CloudflareModelProvider`.
Direct providers use their API keys; **Workers AI is reached over the Cloudflare
REST API** (`CF_ACCOUNT_ID` + `CF_API_TOKEN`) instead of the Worker `AI` binding —
so the whole harness runs locally while still using Cloudflare AI. The Pi-driven
implementation task likewise points Pi at Cloudflare's OpenAI-compatible endpoint.

## Usage

```bash
# 1. Run the matrix → docs/benchmarks/<run-id>/ (candidate outputs + grading/ folder)
pnpm --filter @cat-factory/benchmark-harness bench -- run --config bench.config.ts --name my-run

# 2. Grade with the Claude skill (in Claude Code), which writes grades.json,
#    grading-summary.md and conclusions.md into the run dir:
/benchmark-arbiter docs/benchmarks/my-run

# 3. Fold grades into the final committed report (report.md / report.json):
pnpm --filter @cat-factory/benchmark-harness bench -- grade --out docs/benchmarks/my-run
```

Copy `bench.config.example.ts` to `bench.config.ts` and edit the `models`,
`tasks` and `prompts` matrix. See that file for the model/prompt switches.

## Environment

| Var                                                                                               | Needed for                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN`                                                                   | Cloudflare Workers AI (local), via REST and as the Pi endpoint                 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `QWEN_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` | the matching provider, only if used as a _candidate_ model                     |
| `GH_TOKEN`                                                                                        | cloning a private repo for the implementation task (optional for public repos) |
| `pi` CLI on PATH                                                                                  | the implementation task                                                        |

Arbiter grading needs **no key** — it runs as a Claude skill.

## Prompt versioning

Prompt versions live in
`backend/packages/core/src/modules/agents/prompt-versions.ts` as `id@vN`.
Convention: **edit a prompt ⇒ bump its number**, then benchmark the new version
against the old and commit the run under `docs/benchmarks/`.

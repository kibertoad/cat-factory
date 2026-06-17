---
name: benchmark
description: Run a cat-factory agent benchmark end to end. Use when asked to benchmark, compare, or measure models or prompt versions on the agent tasks (requirement review, code review, implementation) — e.g. "benchmark Llama vs Claude on code review", "compare review@v1 vs a new prompt", "run the benchmark and grade it". Configures the matrix, runs cat-bench, invokes the benchmark-arbiter skill to grade, merges the report, and offers to commit under docs/benchmarks/.
---

# Benchmark runner

Drives a full benchmark of the cat-factory agents: **configure → run the matrix
→ grade (via the benchmark-arbiter skill) → merge the report → commit**. You
orchestrate; you do **not** grade here (the Arbiter is a separate, impartial
skill) and you are **not** a candidate — candidate outputs come only from the
models in the config, run by the harness.

## 1. Settle the config

Figure out, from the user's request, the matrix to run:

- **Tasks**: `requirement-review`, `code-review`, `implementation` (or `all`).
- **Models**: the candidates to compare (e.g. a Cloudflare-AI model vs Anthropic).
- **Prompt versions/variants**: the default built-in (`id@vN`) and/or experimental
  variants. Prompt ids and current versions live in
  `backend/packages/core/src/modules/agents/prompt-versions.ts`.

If a config file already exists (e.g. `bench.config.ts`), use it. Otherwise copy
`backend/internal/benchmark-harness/bench.config.example.ts` to a new
`bench.config.ts` and edit `models`, `tasks` and `prompts` to match the request.
Confirm any non-obvious choice (which models, which prompt variants) with the
user before running — runs cost tokens, and the implementation task is slow.

### Prerequisites (check, don't assume)

- Cloudflare-AI candidates need `CF_ACCOUNT_ID` + `CF_API_TOKEN`; direct providers
  need their `*_API_KEY`. If a needed key is missing, tell the user rather than
  running cells that will all error.
- The `implementation` task needs the `pi` CLI on PATH. If it's absent, skip that
  task (or warn) instead of running it.

## 2. Run the matrix

Run from the repo (the script's cwd is the package dir; the harness still writes
to the repo-root `docs/benchmarks/`). Pick a short, descriptive `--name`:

```bash
pnpm -C backend --filter @cat-factory/benchmark-harness bench -- \
  run --config <abs-path-to>/bench.config.ts --name <run-id>
```

Add `--task <t>` to restrict to one task. The command prints the run directory
(`docs/benchmarks/<run-id>/`) holding `candidates.json`, `manifest.json` and the
`grading/` folder. Report how many cells ran and how many failed; if all failed,
stop and diagnose (usually a missing key or `pi`).

## 3. Grade with the Arbiter skill

Invoke the **benchmark-arbiter** skill on the run directory. It reads each
`grading/<cell>.md`, scores the rubric dimensions, and writes `grades.json`,
`grading-summary.md` and `conclusions.md` into the run dir. Do not grade the
outputs yourself — that is the Arbiter's job, kept separate for impartiality.

## 4. Merge the report

```bash
pnpm -C backend --filter @cat-factory/benchmark-harness bench -- \
  grade --out docs/benchmarks/<run-id>
```

This folds `grades.json` into `report.json` / `report.md`. Surface the headline
result (winner per task, notable prompt-version deltas) from `conclusions.md`.

## 5. Commit

Offer to commit the whole run directory (it's meant to be a committed record):

```bash
git add docs/benchmarks/<run-id> && git commit -m "Benchmark: <run-id>"
```

## Re-running vs re-grading

These steps are independent on purpose. To **re-grade** the same outputs (e.g.
recalibrate), repeat steps 3–4 only. To **re-run** a different matrix, repeat from
step 1 with a new `--name`. Never silently re-run an expensive matrix just to
re-grade.

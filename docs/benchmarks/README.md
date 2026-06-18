# Benchmarks

Committed results of the cat-factory **benchmark harness**
(`backend/internal/benchmark-harness`, CLI `cat-bench`). Each run measures how
different **models** and **prompt versions** affect the quality of three agent
tasks — **requirement review**, **implementation**, and **code review** — graded
by the Claude **benchmark-arbiter** skill.

## Layout

Each run lives in its own directory: `docs/benchmarks/<run-id>/`.

| File                                     | Written by                | Contents                                                                 |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `manifest.json`                          | `cat-bench run`           | Run metadata: date, exact models + prompt versions compared, cell count. |
| `candidates.json`                        | `cat-bench run`           | Every cell's input, output, latency, tokens and estimated cost.          |
| `grading/INDEX.md` + `grading/<cell>.md` | `cat-bench run`           | One self-contained grading task per cell (input, output, rubric).        |
| `grades.json`                            | `benchmark-arbiter` skill | Per-cell dimension scores + weighted total (machine form).               |
| `grading-summary.md`                     | `benchmark-arbiter` skill | Human-readable grading digest.                                           |
| `conclusions.md`                         | `benchmark-arbiter` skill | Standardized conclusions: winners, deltas, recommendations.              |
| `report.json` / `report.md`              | `cat-bench grade`         | Final report joining candidates + grades.                                |

Every artifact records the **exact `provider:model`** and the **exact prompt
version** (`id@vN`) that produced each result, so an outcome is always traceable.

## Prompt versioning

Cat-factory prompts are numbered for change management — each is identified as
`id@vN` (e.g. `build@v1`, `review@v1`, `requirement-review@v1`). The current
versions live in
`backend/packages/agents/src/agents/prompt-versions.ts`.

**Convention: when you change a prompt, bump its number.** Benchmark a new
version against the old one and commit the run here so the impact is on record.

## Running

Easiest: ask Claude to run the **`/benchmark`** skill (e.g. "benchmark Llama vs
Claude on code review"). It configures the matrix, runs the harness, invokes the
grading-only **`benchmark-arbiter`** skill, merges the report, and offers to
commit the run here.

Manual equivalent (see `backend/internal/benchmark-harness/README.md` for detail):

```bash
cat-bench run --config bench.config.ts --name my-run     # → docs/benchmarks/my-run/
/benchmark-arbiter docs/benchmarks/my-run                # Claude skill grades it
cat-bench grade --out docs/benchmarks/my-run             # → report.md
git add docs/benchmarks/my-run && git commit             # commit the run
```

The two Claude skills are deliberately separate: **`benchmark`** orchestrates
(run → grade → merge), while **`benchmark-arbiter`** only grades — so grading
stays impartial and you can re-grade without re-running, or re-run without
re-grading.

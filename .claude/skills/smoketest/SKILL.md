---
name: smoketest
description: Run a cat-factory Pi-agent smoketest end to end. Use when asked to smoketest, sanity-check, or shake out a model on real coding tasks through the actual Pi setup — e.g. "smoketest the new Cloudflare model", "does Llama get stuck on the healthcheck task", "shake out qwen-coder on the coding fixtures". Configures the matrix, runs cat-smoke against actual Cloudflare AI, and surfaces breakage / dead-ends / loops from the captured transcripts. It does NOT grade quality (that's the benchmark skill).
---

# Smoketest runner

Drives a smoketest of the cat-factory **Pi coding agent**: **configure → run the
matrix → read the analysis → commit**. A smoketest answers "can this model do real
coding work through our Pi setup, and where does it get stuck?" — it captures the
**full prompt/response transcript** and analyses it for **breakage, dead-ends and
non-productive loops**. It does **not** rate quality; for that, use the `benchmark`
skill instead.

## 1. Settle the config

From the user's request, decide the matrix:

- **Models**: the candidates to shake out (usually Cloudflare Workers AI models — the
  whole point is exercising actual Cloudflare AI through Pi locally).
- **Fixtures**: which coding tasks (default: all built-ins — add a `/health` endpoint +
  test, add a tested helper, scaffold a tiny service). They live in
  `backend/internal/smoketest-harness/src/fixtures.ts`. Point one at a specific repo by
  editing the fixture / the config's `fixtures`.

If a config exists (`smoke.config.ts`), use it. Otherwise copy
`backend/internal/smoketest-harness/smoke.config.example.ts` to `smoke.config.ts` and
edit `models` (and `fixtures` if narrowing). Confirm non-obvious choices with the user —
runs cost tokens and the implementation flow is slow.

### Prerequisites (check, don't assume)

- Cloudflare-AI candidates need `CF_ACCOUNT_ID` + `CF_API_TOKEN`; direct providers need
  their `*_API_KEY`. If a needed key is missing, say so instead of running cells that
  all error.
- The `pi` CLI must be on PATH. If it's absent, the run will report `pi-not-runnable`
  for every case — install Pi first.
- This is a **local** tool — never run it in CI.

## 2. Run the matrix

```bash
pnpm -C backend --filter @cat-factory/smoketest-harness smoke -- \
  run --config <abs-path-to>/smoke.config.ts --name <run-id>
```

Useful flags: `--fixture <id>` (one task), `--relax-guard` (let a looping run finish so
it's captured whole instead of being killed at the guard threshold — use when
investigating a loop). The command prints the run directory
(`docs/smoketests/<run-id>/`) and a verdict tally; it exits non-zero if any case is
`broken`.

## 3. Read the analysis

Open `docs/smoketests/<run-id>/report.md` — the verdict table + "what to look at first".
For each non-healthy case, drill into `cases/<case-id>/`:

- `analysis.md` — verdict, findings (e.g. `no-op-run`, `guard-no-edits`,
  `repeated-tool-call`, `terminal-model-error`), metrics.
- `transcript.md` / `transcript.jsonl` — what the agent actually did (the full
  prompts + responses).
- `diff.patch` — what it changed.

Summarise for the user: which models are healthy, which are broken/degraded and **why**
(cite the finding codes), and anything actionable (a model that never edits, a loop, an
endpoint that 502s). For deeper qualitative read-through of a specific failing case, the
`investigate-telemetry` skill is the production analogue.

## 4. Commit

Offer to commit the run directory as a record:

```bash
git add docs/smoketests/<run-id> && git commit -m "Smoketest: <run-id>"
```

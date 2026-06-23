---
'@cat-factory/executor-harness': minor
---

Raise the harness output ceiling and guard against malformed final answers.

- `PI_MAX_OUTPUT_TOKENS` 16k → 32k (and the structured-repair call now references it
  rather than hard-coding 16k). It is a per-completion ceiling, not a target — unused
  tokens are unbilled and Workers AI clamps to the model's real max — so this is safe
  headroom for larger specs/diffs. The shared LLM proxy (`@cat-factory/server`,
  served by both runtimes) only FLOORS workers-ai output, it does not cap, so the
  higher request flows through unchanged on Cloudflare and Node alike.
- New `runDiagnostics` over Pi's transcript reports whether any completion hit the
  output ceiling (`truncated`/`finalTruncated`) and whether the agent's final turn
  produced no text at all (`finalAnswerEmpty` — an empty `content: []` despite spent
  output tokens, observed from `kimi-k2.7-code`). It is computed universally but acted
  on per agent: the document producers that hand a final answer ONWARD to be reviewed
  (spec-writer, blueprinter) now fail loudly with a clear cause instead of letting the
  structured-output repair manufacture a half-baked artifact from garbage. Side-effect
  agents (coder/ci-fixer/conflict-resolver pushing a PR or commit) are unaffected — an
  empty final turn is normal for them.

Bumps the runner image tag to 1.5.0 (deploy/backend `image:publish` + wrangler.toml).

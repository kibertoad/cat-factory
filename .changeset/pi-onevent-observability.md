---
'@cat-factory/executor-harness': patch
---

Add an optional `onEvent` callback to `runPi` — the raw observability seam over a Pi
run. It is invoked with every parsed Pi `--mode json` event in stream order (the full
prompt/response/tool-call transcript), so offline tooling (the new smoketest harness)
can capture and analyse what a model actually did without re-implementing the Pi
driver. The container payload doesn't pass it, so production behaviour is unchanged;
a throwing handler is swallowed so a faulty observer can't break a run. Touches the
harness `src/**`, so the image tag bumps with it.

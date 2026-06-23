---
'@cat-factory/server': patch
---

Raise the container LLM-proxy session-token TTL from 30 to 90 minutes so a long but
healthy agent step can't 401 mid-run.

The harness job watchdog lets a step run up to `JOB_MAX_DURATION_MS` (default 60 min),
but the per-run session token (`DEFAULT_SESSION_TTL_MS`) expired at 30 min. The token
is minted at dispatch, before the container boots and Pi starts, so its clock leads
the job's by the boot/dispatch latency. A spec-writer run on a slow Workers AI model
(`kimi-k2.7-code`, with repeated 4-minute upstream timeouts) ran ~34 min and died with
`401 Invalid or expired session token` while the watchdog still considered it alive.

90 min clears the 60-min watchdog ceiling plus the boot lead with margin. The token
stays tightly scoped (audience `llm-proxy`, one workspace, one execution, locked
provider+model), so the longer life is a small risk increase: a leak can only spend
that run's metered budget on that one model. The token is minted with no `ttlMs`
override in `ContainerAgentExecutor`, so both runtimes pick up the new default.

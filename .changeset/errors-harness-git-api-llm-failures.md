---
'@cat-factory/executor-harness': patch
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
---

Classify harness clone/push, PR/MR-open, and LLM-proxy failures with actionable remedies
(error-message initiative F1–F3).

The executor-harness surfaced three common runtime failures as raw, opaque text: a git
`Authentication failed` / `repository not found` stderr line, a bare `Failed to open PR
(HTTP <status>)`, and — for a run where every model call was refused — Pi's terse
`finalError` classified only as a generic `agent` failure. Each now names the cause and the
fix, at the single point where the third-party text enters our system (per the initiative's
first-wrap-point rule); the raw line is preserved as detail, only the remedy is appended.

- **F1 (git):** `describeGitFailure(stderr)` matches the auth / repository-not-found /
  write-permission shapes and appends a host-neutral remedy (reconnect the GitHub App, or in
  local mode regenerate the `GITHUB_PAT`; confirm repo visibility / write access), keeping the
  `git` structured cause.
- **F2 (PR/MR open):** `describePrOpenFailure(status, provider)` maps 401 / 403 / 404 /
  422 (GitHub) / 400 (GitLab) to a remedy tailored per provider (GitHub App "Pull requests:
  write" vs GitLab `api` scope; the PR vs merge-request noun), keeping the `api` cause and the
  load-bearing `Failed to open …(HTTP n)` first line.
- **F3 (LLM proxy):** a new `llm-upstream` `FailureCause` (mirrored in the kernel
  `HARNESS_FAILURE_CAUSES` union, mapped to the coarse `agent` kind). When Pi's terminal error
  is the proxy refusing every call, `classifyLlmUpstreamError` distinguishes auth (401/403),
  quota/credit (402) and rate-limit (429) and stamps `HarnessFailure('llm-upstream', …)` with
  the matching fix (re-enter the provider key in the AI key pool / top up quota / wait and
  retry) instead of a generic agent failure. The structured cause rides `RunnerJobView`'s
  `failureCause` to the engine as `AgentFailure.reason`.

This bumps the executor-harness image tag (`1.43.3`) and the three hand-maintained pins.

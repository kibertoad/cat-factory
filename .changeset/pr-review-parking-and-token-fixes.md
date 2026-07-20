---
'@cat-factory/app': minor
'@cat-factory/server': patch
'@cat-factory/executor-harness': minor
---

Implement the follow-ups from the PR-review run investigation (#1261): the parked PR-review
approve bug, misleading token surfacing, and session-transcript retention.

- **PR-review "Review & approve" now opens the findings-selection window.** A parked
  `pr-reviewer` step carries both a pending approval and `prReview.status`, so every board /
  pipeline / inspector surface funnelled its generic approval button into the prose panel (wrong
  endpoint, no findings UI) instead of `PrReviewWindow`. `dispatchStepView` now special-cases a
  step carrying `prReview` (mirroring the `consensus` case) and `pr-reviewer` is modelled in the
  frontend catalog with `resultView: 'pr-review'`, so the existing approval button routes
  correctly. A dedicated "Review findings" chip (mirroring the fork-decision chip) is added to the
  pipeline rail and the inspector.

- **Container token usage records the real model.** The durable poll path
  (`ContainerAgentExecutor.pollJob`) folds `handle.model` onto the result, so `spend.record` /
  `token_usage` records the actual `provider:model` instead of `unknown` / `""`.

- **Token surfaces separate fresh vs cached input.** A long agentic run re-sends its whole
  transcript every turn, so the raw prompt-token sum is ~all cache reads and reads as a blow-up.
  The step-metrics bar and the observability panel now show FRESH (uncached) input as the headline
  with the cached prefix called out separately (a new `freshPromptTokens` helper).

- **Session transcripts are retained for 3 days.** Both subscription runners
  (`runClaudeCode` / `runCodex`) deleted the isolated config home — with the CLI session
  transcripts — in `finally`. A new `retainSessionTranscripts` lifts ONLY the transcript subtree
  (`projects/` / `sessions/`) out to a retention root before the credential-bearing home is
  deleted, and prunes on a 3-day TTL (overridable via `HARNESS_TRANSCRIPT_TTL_MS` /
  `HARNESS_TRANSCRIPT_ROOT`). The credential at the home root is still removed.

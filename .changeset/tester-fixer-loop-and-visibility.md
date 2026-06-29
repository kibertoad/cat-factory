---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': patch
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

Three related issues in the API/UI Tester flow:

- **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
  regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
  to an existing entry rather than re-running (replay idempotency). A container-reusing
  transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
  rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
  re-attached to its FIRST round's completed job and silently replayed the stale report. Each
  re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
  job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
  CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
  with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
  The conformance suite now models a pooled container so the loop is exercised faithfully.

- **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
  of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
  timeline in the test report window instead of only a bare "N/M fix" count.

- **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
  meaningfully tested — its ephemeral environment never came up, a required dependency is
  missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
  the step's ephemeral environment is in a `failed` state). The run stops, the block is left
  blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
  dispatched, since it cannot provision infrastructure.

This is a breaking change to the persisted Tester step state and the test-report wire shape
(new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
may simply break rather than migrate.

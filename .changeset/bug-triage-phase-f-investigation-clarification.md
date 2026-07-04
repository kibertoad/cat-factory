---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
and the gate learns to seed itself from that triage instead of running its own first LLM pass.
Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

- **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
  `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
  `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
  `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
  (non-empty only when clarification is needed). Its structured object lands on `step.custom`
  (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
  a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
  The old prose ROLE entry is removed.
- **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
  image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
  container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
  gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
  involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
  makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
  cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
  optional (present for the coding fan-out, absent for the read-only one).
- **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
  investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
  no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
  notification) and seeding one blocking finding per `question` on `needs_clarification` (park
  for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
  now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
  paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
- **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
  best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
  the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
  comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
  tracker outage never fails the run.
- **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
  auto-passes straight through to the next step with the digest recorded, and
  `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
image-tag pins are synced.

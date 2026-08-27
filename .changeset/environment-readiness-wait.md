---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Wait for an ephemeral environment to actually come up, and refuse to test one that has not

A `deployer` step provisioned an environment through an asynchronous provider, which returned in
1.9 seconds with the environment still building, and the step recorded the task's own frame
`ready` anyway. Nothing read the provider again for the rest of the run. `tester-api` was
dispatched a second later with `URL: (pending)` beside an instruction to test that URL; the
environment came online 5m36s after the create call, while the tester was still running, and the
run never noticed. The tester did not take the bail-out its prompt offers either: it reconstructed
the deployment locally, tested that, and returned `greenlight: true` with the environment itself
recorded as skipped, on a task whose whole brief was to stand that environment up.

Three changes, in the order the run hits them:

- A provider answer that is not `ready` is no longer recorded as `ready`. `provisioning` parks the
  step on a readiness wait; anything else records the frame failed, naming the state.
- The wait re-reads the provider's own `status()` between driver polls until the environment is
  ready, reaches a state it will never leave, or crosses a 20-minute ceiling. It is a first-class
  park (`awaiting_environment`) on both durable drivers, and it is visible while it happens: the
  step's Environment panel shows the environment spinning up rather than an idle-looking run.
- A step whose run mode IS the ephemeral environment and that has no reachable URL is refused at
  dispatch instead of being handed a contradictory prompt. Two causes, two codes: an environment
  that exists but is not reachable (`environment_not_ready`) and a run that provisioned none at
  all (`environment_missing`, a pipeline reaching a tester with no `deployer` ahead of it).

`EnvironmentFailureReason` gains those two members; a readiness ceiling that expires reports the
existing `timeout`.

Two behaviour changes worth knowing about beyond the headline:

- **An involved-service (peer) frame now waits too**, where a peer that was not `ready` used to be
  dropped on the spot as enrichment the run could proceed without. A peer is not only enrichment:
  its URL is fed into the NEXT frame's provision inputs, and frames are provisioned
  provider-before-consumer precisely so a consumer can template its provider's address into its own
  manifest. Dropping a peer that is still building therefore provisions the consumer (usually the
  task's own frame, which goes last) against an address that is silently missing. Under an
  asynchronous provider every peer answers `provisioning` first, so the old fast-drop made that
  ordering guarantee vacuous. The cost is that a peer stuck coming up now holds the run up to the
  readiness ceiling instead of being dropped instantly; it still settles non-terminally.
- **Both durable drivers now drain parks in a loop rather than a fixed branch sequence.** A poll
  routinely resolves into a _different_ park (a deploy job settling into an environment that is
  still building; a `ci` gate dispatching a `ci-fixer`), and only a loop makes the order of those
  branches irrelevant. The Worker's durable step names are scoped per hop as a result, so a
  Workflows instance in flight across the upgrade re-issues the polls of its current step rather
  than replaying memoised ones.

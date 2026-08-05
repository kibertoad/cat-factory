# @cat-factory/mcp-server

## 0.11.0

### Minor Changes

- bac6776: Follow-up triage and interview-gate decisions over the public API

  `/api/v1` answered every park a pipeline can carry except three. Two of those were surfaces nobody
  had built (`docs/initiatives/public-api-additions.md` found them while landing the rest, and left
  them unranked); this lands both, leaving `human-review` as the only ❌ row, and that one is
  unanswerable by construction, since its answer is a person approving the pull request on the VCS
  host rather than an API call.

  **Follow-up triage** (`…/decisions/follow-ups/items/:itemId/{file,send-back,answer,dismiss}`) is the
  first decision here that is not a park: the Coder streams forward-looking items while it is still
  running, so the projection lists them whenever any item is `pending` rather than once the run is
  `blocked`. An integration that triages as they arrive never sees the run stop at all.

  **Interview gates** (`…/decisions/interview/{answer,continue,proceed}`) are ONE route set for every
  interviewer, keyed by run alone: which interviewer is asking is a property of the parked step, so
  the server resolves it and the decision's `stepKind` reports it. That needed a new seam: the two
  built-in gates store their Q&A on entities belonging to their own features, so `InterviewGateKind`
  now projects a kind-neutral `InterviewView` (the questions and the round budget, deliberately not
  the brief each one converges on), reached through the narrow `InterviewGate` interface rather than
  the entity-generic controller. A third interviewer implements `view` and needs no route, projection
  or decision kind of its own; it does still wire its controller, since an interview gate is built
  from its feature's own store rather than constructed by a registry. Registered-but-unwired is a
  real state and reports as one: admission counts the park (it reads the trait), the projection lists
  nothing, and the routes 503 naming the kind. Its question `status` is derived, not stored: one gate
  keeps an explicit `dismissed` marker and the other has only the answer, so one derivation is what
  lets a caller read both through one shape.

  Worth reviewing, because it is a behaviour change rather than an addition: **an interview gate is now
  a park surface the start rule can see**, read off the step kind's `interview-gate` trait. That closes
  a hole in the wrong direction: an interviewer is an INLINE step, so a pipeline built out of
  interview steps satisfied the inline-only rule and was reported `headlessStartable` while every run
  of it stopped on the first batch of questions. No shipped preset changes hands (`pl_initiative` and
  `pl_document` both carry a later human gate and were already admitted as parking on it); what
  changes is that the refusal names the interview, and that a pipeline whose only park is the
  interview is finally refused for a `write` key.

  **Follow-up triage is deliberately NOT added to that rule**, and the trade-off is stated in
  `backend/docs/public-api.md` rather than left to be discovered: the companion is on by default on
  every Coder step, so counting it would make `decide` mandatory for all board work that builds
  anything and take board starts away from every live `write` key at once. The park now has an answer
  path, so a run that stops there is recoverable with a `decide` key instead of being app-only.

  Also noted rather than fixed, in the same three places a reader would look: an unbounded human-wait
  GATE a deployment registers itself is invisible to the start rule, because a gate declares
  `pollExhaustion` on the object its factory builds from an engine context and nothing can read that
  at HTTP request time. Such a pipeline is admitted for a `write` key and then parks with nothing on
  this surface able to name it. The tracker ranks the fix (declare `pollExhaustion` at registration
  and read the registry, which also retires the hand-kept `HUMAN_WAIT_GATE_KINDS` constant) as its own
  slice, since it changes the `GateRegistry` seam.

  Public API surface version `1.10.0`, additive: two new decision kinds (`follow-ups`, `interview`) and
  seven endpoints, all `decide`-scoped.

### Patch Changes

- Updated dependencies [bac6776]
  - @cat-factory/sdk@0.13.0

## 0.10.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

### Patch Changes

- Updated dependencies [e7867db]
  - @cat-factory/sdk@0.12.0

## 0.9.0

### Minor Changes

- c5a1a16: Per-step gate configuration: approver policies, approval quorums, and gate-declared settings

  `Pipeline.gates: boolean[]` said a step paused for "a human" and nothing else. There was nowhere to
  say which humans, how many of them, or what a registered gate's own knobs should be for this
  particular step — the built-in gates read their attempt budgets and time windows off the
  workspace-wide merge preset, and a deployment's own gate had nowhere to put its parameters at all.

  A step now carries `stepOptions.gateConfig` (the extensible per-step bag, so no column and no
  migration on either runtime), with two halves. The platform owns `approvers` and `minApprovals`: who
  may resolve the human gate, and how many DISTINCT people must, both snapshotted onto the approval
  when the gate is raised so an edit to the pipeline cannot move the bar under the people already
  counted toward it. The GATE owns `fields`, declared on its registration
  (`register(kind, factory, { configFields })`) as descriptor fields — one declaration driving the
  save-time validation, the run-start re-validation and the authoring form the builder renders, so a
  registered gate needs no frontend change to become configurable. The built-ins declare their own
  (`maxAttempts`, `watchWindowMinutes`, `graceMinutes`) instead of the engine hard-coding them.

  Behaviour changes worth reviewing. The approver policy governs all three resolutions, not just
  approve: a gate the wrong person can reject is not a gate. A workspace admin always passes a policy
  (they can cancel the run or edit the pipeline anyway, and refusing them would deadlock a gate whose
  named approvers have left). A machine key or an auth-disabled caller is refused by any policy — a
  shared credential is not one of the people a policy named — which also means a quorum above one
  cannot be met on a deployment running with auth off, since counting distinct approvals needs
  identities that deployment does not have. All of this is additive: a gate with no config behaves
  byte-for-byte as it did.

  A quorum votes on ONE artifact, so only the approval that CLEARS the gate may carry a `proposal`
  edit. An edit on an earlier approval is refused (`proposal_not_editable_until_quorum`) rather than
  silently rewriting the text under the people already counted toward the bar; the SPA withholds the
  affordance and says why. Both raise sites for the human gate now go through one `buildStepApproval`
  builder, so a gated COMPANION step honours the policy and quorum its step configured.

  Public API (`/api/v1`, surface version now `1.9.0`, additive): the `approval-gate` decision projects
  `requiredApprovals` and `recordedApprovals`, because a quorum makes `approve` legitimately not
  advance the run and without the tally a caller could not tell that from a failed call.

  Internal break, per the pre-1.0 rule: `ExecutionService.approveStep` / `requestStepChanges` /
  `rejectStep` now require a `GateActor`. Required rather than optional so an entry point that forgets
  to supply the acting identity fails to typecheck, instead of silently resolving a gate that names
  its approvers as though it named nobody.

  Design record: `backend/docs/adr/0038-per-step-gate-config.md` (supersedes the
  `extensible-custom-gate-config` initiative tracker, removed).

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/sdk@0.11.0

## 0.8.0

### Minor Changes

- 289b3de: Disposer step, and a teardown that is proved rather than assumed

  A run's PR asserts a three-leg proof — the test environment came up, evidence was captured against
  it, and it was torn down again — and the third leg had two problems.

  Nothing closed it inside the run. Teardown happened only on the TTL sweep, a manual Destroy, a
  `human-test` resolution, or a re-provision supersede. The sweep fires long after the last step
  settled, so the report was published saying the environment was still live and corrected later
  through a back-channel, and only where a provisioning log is retained. TTL is a backstop; it
  cannot be a proof.

  Worse, the teardowns that did happen were never checked. Success was recorded whenever
  `provider.teardown()` returned without throwing, which is a different fact from the environment
  being gone: `HttpEnvironmentProvider` reports `torn_down` unconditionally, so a manifest with no
  `teardown:` request destroys nothing and still reports success, and a Kubernetes namespace
  `DELETE` returns while the namespace is still `Terminating`. The section could therefore render a
  green tick about an environment that was still running and still billing.

  So teardown now has two halves. A new optional `EnvironmentProvider.confirmTeardown` re-probes
  after the destroy call and the result is recorded as its own `teardown-verify` log row; only a
  probe that positively finds the environment gone counts as a reclaim. This is deliberately not
  folded into `status()`, whose implementations are all written to describe a LIVE environment — the
  generic provider with no `status:` template answers `ready` forever, and the compose mapping reads
  an empty project as `failed`, both of which are exactly inverted as teardown verdicts. The four
  outcomes stay distinct because each needs a different person: confirmed, still standing (the
  teardown was a no-op — fix the config and reclaim by hand), unverifiable (the provider has no way
  to tell you, and no retry will change that), and unconfirmed (transient; the next sweep re-probes).

  And a new `disposer` step, the deployer's counterpart, reclaims what the run provisioned wherever
  its author places it — after the automated tester, or after a human has finished with the live
  URL. It never fails the run: it commonly sits after `merger`, so an un-reclaimed environment is a
  recorded warning and an operator's job, not a failed pipeline. It is palette-addable rather than
  seeded into the built-in pipelines; seeding it is a follow-up that needs its own version bumps.

  Crucially it reclaims BY IDENTITY, not by re-resolving. The deployer now records which environment
  each frame got (`deployEnvs[frame].environmentId`) and the disposer tears down exactly that one.
  Re-resolving from `(block, frame)` reads correct and is not: that lookup falls back to the block's
  frame-less row, which is where the manual and `human-test` environments live, so a disposer running
  after a supersede, an operator's Destroy or a TTL sweep on a long run would have destroyed an
  environment the run never provisioned and recorded it as the frame's clean reclaim.

  The provisioning-log operation vocabulary is part of `/api/v1`, so `teardown-verify` is an
  ADDITIVE public-API change: the OpenAPI surface goes to 1.9.0 and the four SDK clients plus the
  MCP facade are regenerated from it. The SDKs tolerate unknown enum values by design, so an older
  client decodes the new row as a plain string rather than failing.

  One ordering detail is worth understanding, because getting it wrong made the whole feature
  unreachable while every unit test still passed. The hook that re-publishes the PR report on a
  teardown fires from the same place that writes the log rows, and its consumer RE-READS that log.
  Fired between the teardown row and the confirmation row it sees a teardown nothing has verified,
  publishes `unconfirmed`, and — being the last edge on an already-settled run — is never corrected.
  Both writes and the notification therefore happen in one method that takes the confirmation, and
  the regression test asserts the row count at hook time rather than the final rows, since only that
  can see the order.

  Two things to watch when reviewing. The report gains a `teardown: 'unconfirmed'` state, and
  because a missing verify row is treated as "not proved" rather than as a pass, runs whose
  teardowns predate this change will report unconfirmed rather than confirmed. That is a correction,
  but a visible one. And the confirmation applies to every teardown path, not just the new step, so
  a deployment whose provider config makes teardown a silent no-op will start being told so.

### Patch Changes

- Updated dependencies [289b3de]
  - @cat-factory/sdk@0.10.0

## 0.7.0

### Minor Changes

- 99be350: Public API: answer every remaining park a run can stop on

  `/api/v1/runs/:runId/decisions` could answer four parks; a `decide` key could START many more than
  that, so a caller could put a run into a state only the app could get it out of. Twenty-four
  additive endpoints close the gap: the generic approval gate (approve / request-changes / reject,
  plus `resolve-exceeded` for a companion at its rework cap), agent-raised decisions, the
  clarity-review and both brainstorm loops, PR deep-review curation, and the two human-verdict gates.
  The decision list gained seven kinds alongside them, and the OpenAPI surface version is now `1.7.0`.

  Of the parks a pipeline can carry, only `human-review` is now unanswerable, and by construction
  rather than omission: its answer is a person approving the pull request on the VCS host. Two park
  surfaces the original investigation missed (follow-up triage, interview gates) are recorded in
  `docs/initiatives/public-api-additions.md` as unbuilt and are NOT advertised as answerable.

  Behaviour change worth reviewing: a park that rides the engine's generic `step.approval` but is
  owned by a dedicated surface (a review gate, a fork choice, a human-verdict gate, follow-up triage,
  an interview) is reported as its own kind, never as `approval-gate`, because the engine refuses the
  generic verbs on those. `StepDecisionController`'s refusal and the public projection now read one
  shared classifier so the two cannot disagree.

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/sdk@0.9.0

## 0.6.0

### Minor Changes

- 8511a90: MCP maturation slice 3: the public API is now served over MCP from the deployment itself.

  `POST /api/v1/mcp` speaks Model Context Protocol behind the same public-API key auth as every other
  `/api/v1` route, so an MCP host reaches a deployment with a URL and a key and nothing installed. That
  is the point of the slice: until now "drive cat-factory from a model" meant an npm dependency, a local
  process per host and a long-lived key in the host's plaintext config, which rules out claude.ai, hosted
  agents and anything that cannot spawn a subprocess. The stdio binary stays, for hosts with no HTTP MCP
  support and for use against a deployment you do not run.

  It is the SAME server behind both paths: the endpoint mounts `@cat-factory/mcp-server`'s
  `handleMcpHttpRequest`, so the generated tool table, the instructions and the result rendering are the
  same bytes, and every tool call is one `/api/v1` request under the CALLER's own forwarded key. Nothing
  is reachable over MCP that the same key could not reach with `curl`. Behaviour worth knowing about:
  the key's SCOPE decides the tool list (a `read`-scoped key is served only the tools that change
  nothing, and the instructions say a wider key would expose the rest, so a model asks for one instead of
  reporting the platform as unable to write); above `read` the whole table is listed and each tool's own
  rung is enforced by the endpoint it calls, arriving as tool content the model can act on; and the
  endpoint is stateless with JSON responses, so `GET` and `DELETE` are answered `405`.

  Two things a caller and an operator each notice. A tool's `/api/v1` call INHERITS the MCP request's
  `X-Request-Id`, so the tool call and the API call it caused share one correlation id and a log holding
  both lines can be joined on it (supply your own on the MCP request and both halves land under it).
  And `Mcp-Protocol-Version` joins the shared CORS allow-list both facades serve, without which a
  cross-origin BROWSER host would negotiate successfully and then have every later call dropped by the
  browser, since a Streamable HTTP client sends that header on every request after `initialize` and on
  none before it.

  The endpoint joins the PUBLIC surface under the stability contract from this release. It is
  deliberately absent from `docs/openapi.json`: a JSON-RPC endpoint has no operation shape to describe,
  and describing it would mint an SDK method in four languages for a protocol none of those clients
  speaks. `backend/docs/public-api.md` carries the obligation instead, which also means the endpoint's
  arrival does not move the spec's `info.version`: that version tracks the described surface.

  `@cat-factory/mcp-server` gains `handleMcpHttpRequest` / `refuseMcpMethod`, so any deployment of this
  API can mount the endpoint, plus a `readOnlyReason` option that lets the instructions name the right
  fix for a narrowed tool list.

  INTERNAL BREAK in `@cat-factory/mcp-server`: `optionsFromEnv(env, deps)` now REQUIRES
  `deps.readSecretFile` rather than defaulting to `readFileSync`, and `ToolSelection.writeToolsHidden` is
  a `ReadOnlyReason | null` rather than a boolean. The first is what keeps every module the hosted
  endpoint reaches free of Node built-ins: those modules are bundled into deployments' Workers, where
  `node:fs` does not resolve at build time, so the default was a Worker that fails to BUILD for the sake
  of a code path it can never take. `bin.ts` supplies the reader.

### Patch Changes

- @cat-factory/sdk@0.8.0

## 0.5.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/sdk@0.8.0

## 0.4.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/sdk@0.7.0

## 0.3.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
  - @cat-factory/sdk@0.6.1

## 0.3.0

### Minor Changes

- a8acd48: Bring the published MCP server under the repo's publish guards and give it the protocol depth the
  generator already had the data for.

  The tool table now declares an `outputSchema` for every operation that answers with a JSON object and
  returns `structuredContent` beside the text, so a host or agent framework can consume a result without
  re-parsing prose. Those schemas are rendered deliberately loosely (no `required`, no `enum`, no closed
  `anyOf`, no bounds, and for a union not even `type`): a caller's MCP client validates against them and
  `/api/v1` is additive forever, so anything stricter would let an older copy of this package reject a
  newer deployment's honest answer. `destructiveHint` / `idempotentHint` are now set on the operations whose consequence is real
  money or a merged pull request, and left unset elsewhere so the protocol's cautious defaults stand.

  Two behaviour changes to know about:

  - **A result over `CAT_FACTORY_MCP_MAX_RESULT_CHARS` is now refused rather than truncated**, with a
    message naming the size, the limit and the way out (`limit` / `cursor` / `offset`, or a bigger cap).
    Half an object cannot satisfy the output schema it was cut out of, and the old `[TRUNCATED]` prefix
    spent the whole cap delivering the instruction to narrow instead of reading on.
  - **Results are compact JSON**, not two-space indented.

  New configuration: `CAT_FACTORY_API_KEY_FILE` reads the key from a file instead of the host's
  plaintext config (setting both is refused, not resolved by precedence), and
  `CAT_FACTORY_MCP_TOOLS` / `CAT_FACTORY_MCP_EXCLUDE_TOOLS` filter per tool beside the existing group
  filter, so withholding the PR-merging `notifications_act` no longer costs the whole inbox group. Every
  filter is stated in the server's instructions, and a combination that would expose no tools at all
  fails at startup.

## 0.2.1

### Patch Changes

- Updated dependencies [10e0341]
  - @cat-factory/sdk@0.6.0

## 0.2.0

### Minor Changes

- 43fd5c0: Add `@cat-factory/mcp-server`: a Model Context Protocol facade over the public API, so an MCP host
  can drive a workspace directly (plan work on the board, start and watch runs, answer parked
  decisions, read a run's telemetry).

  It is a facade rather than a fifth client. The tool table is rendered by `pnpm gen:sdk` from the
  same `docs/openapi.json` the four SDKs are generated from, and every tool is one call on
  `@cat-factory/sdk` — so it cannot drift from the surface it exposes, and it re-implements none of
  the SDK's auth, retry, error, pagination or encoding behaviour. `pnpm check:sdk` covers it.

  Every operation is a tool except the two SSE endpoints: a tool call returns one result over no
  streaming channel, and a bounded "wait for the run" tool would be a timeout dressed up as an
  answer, since a parked run waits for a human indefinitely by design. The server names both
  omissions, and their alternatives, in its instructions; generation fails on a new streaming
  operation nobody has classified.

### Patch Changes

- @cat-factory/sdk@0.5.0

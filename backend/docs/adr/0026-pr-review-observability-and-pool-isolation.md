# ADR 0026: PR-review run observability and warm-pool isolation

- **Status:** Fully implemented — D1–D7 all landed
- **Date:** 2026-07-21
- **Context layer:** backend (`@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/contracts`, executor-harness, `backend/runtimes/local`) + frontend (`@cat-factory/app`)
- **Relates to:** ADR 0023 (PR deep review), `backend/docs/container-reaping.md`, PR #1296 (E2BIG fold fix)

## Context

A `pr-reviewer` run against a 518-file PR (`checkboxsurvey/Checkbox-Application#4558`, the identity-model epic) looked hung in the UI. It sat on "Slicing…" with 0% progress and no findings for about 17 minutes, then failed with "The container failed to start." The report was that reruns start broken and that the reviewer was burning tokens just to slice the work.

I investigated the live run in local mode (Docker executor, local Postgres on 5433) before it died. None of the surface symptoms matched what was actually going on. This ADR records what the run was really doing, the gaps that made a healthy run look broken, and a design for closing them. It also covers a warm-pool isolation hazard that is latent on any machine running two local installs against one Docker daemon.

### What the run was actually doing

The run was not hung and it was not stuck slicing. Reconstructed timeline for `exec_558a81b0`:

- **07:04** container dispatched; `git clone` of the base branch ran for 111s (~179 MB).
- **07:06** clone finished, `claude -p` (v2.1.207) started. The PR #1296 fix worked as intended: the composed system prompt was ~148 KiB, overflowed the single-argv `MAX_ARG_STRLEN` limit, and was folded into the stdin task prompt (`system prompt exceeds argv limit; folding into the task prompt`).
- **07:06–07:23** the agent read the injected `.cat-context/pr-diff.md` (306 KiB covering all 518 files), grouped the diff into six cohesive slices, and reviewed them **in parallel** using general-purpose subagents. The live subagent transcripts were named `Review security/ACL slice`, `Review contact core slice`, `Review auth/session slice`, `Review groups/roles/userstores slice`, `Review migration SQL slice`, and `Review responses/reporting/invitations slice`. The newest was 504 KiB and still growing at 07:19, with eight established HTTPS connections to `api.anthropic.com`. This was real, healthy review work.
- **07:23** the container was evicted (it vanished mid-run). The dispatcher spent its one recovery (`evictionRecoveries: 1`), the re-dispatch threw, and the throw fell through the classifier's catch-all to the generic "The container failed to start." The run is now `failed`.

The slicing itself was cheap. The `prReviewerDiffPreOp` hands the agent the changed-file list plus budgeted patches up front, and the agent groups from that list without reading file bodies. The token spend (~295K output tokens across the six subagents, with much larger input from re-sent transcripts) is the actual review of a very large PR, not wasted slicing effort.

## Problems

Five distinct issues, ordered by how directly they caused the "looks broken" experience.

### P1 — Misleading terminal failure text

A run that clones, spawns the agent, and does 17 minutes of review, then loses its container to an eviction and fails its single recovery, is reported as "The container failed to start." That comes from the catch-all in `classifyDispatchFailure` (`backend/packages/orchestration/src/modules/execution/job.logic.ts`): any throw from the recovery re-dispatch that is not a `DomainError`, a container-eviction error, or a `DispatchError` is framed as a fresh-start failure. The message contradicts the fact that work had already happened, which is why the incident read as "reruns start broken."

### P2 — "Slicing…" is inferred from the absence of a parent todo list

`frontend/app/app/components/prReview/PrReviewWindow.vue` computes the slicing sub-phase as:

```ts
const slicing = computed(() => status.value === 'reviewing' && isSlicingChunks(subtasks.value))
```

`isSlicingChunks` (in `~/utils/prReviewProgress`) means "no todo list yet." The `prReviewStatus` enum in `@cat-factory/contracts` has no `slicing` member at all (`reviewing → awaiting_selection → … → done`); "slicing" is a UI-only sub-phase derived from an empty subtask list. The design assumed the reviewer maintains a parent-level TodoWrite plan (one entry per slice) that surfaces progress. When the agent reviews via parallel subagents, it never writes that parent todo list, so `subtasks` stays empty and the UI is pinned at "Slicing…" for the whole review. The heuristic "no todo list yet ⇒ still slicing" is wrong for the subagent execution shape.

### P3 — Subagent work is invisible to the harness

The executor-harness reconstructs progress, activity, and telemetry from the parent `claude` process's `stream-json` stdout (`streamCli` and the `onEvent` accumulator in `backend/internal/executor-harness/src/agent-runner.ts`). Subagent turns are written to separate `subagents/*.jsonl` transcript files and do not appear on the parent stream between the Task dispatch and its final tool_result. Three consequences:

- **Progress:** the `TodoWrite → onProgress` path never fires for subagent-driven review, so the step's progress stays 0 (feeds P2).
- **Heartbeat:** the backend's `agent_runs.updated_at` only advances on progress changes, so it froze at the moment the agent started (07:06:15) even though the run was alive and working. A quiet-but-alive run is indistinguishable from a wedged one from the DB.
- **Telemetry:** `token_usage` for the execution stayed at 0 rows during the whole review because usage is recorded at job end, not incrementally. Cost accrued invisibly (hundreds of thousands of output tokens, larger input).

### P4 — No early signal for a genuine cold-start wedge

The inactivity watchdog (default 10 min, `JOB_INACTIVITY_MS`; `git.ts` derives its own timeout strictly below it) is the only backstop. It eventually fires, but it is a blunt, late instrument. The pre-seed of `.claude.json` (`hasCompletedOnboarding`, `bypassPermissionsModeAccepted`, `hasTrustDialogAccepted`) exists precisely because a fresh config home otherwise blocks `claude -p` on interactive onboarding with zero output. If a future CLI adds a new first-run gate the pre-seed does not cover, the symptom is identical to a healthy-but-quiet subagent run: no stdout, low CPU. Today nothing tells the two apart until the 10-minute window elapses.

### P5 — Warm-pool cross-install contamination

`backend/runtimes/local/src/container.ts` runs a warm pool of pre-warmed executor containers, reaped and re-warmed at startup. Pooled containers bake `HARNESS_SHARED_SECRET` (and other config) in at creation. This machine runs two installs against one Docker daemon (`checkbox-cat-factory-postgres-1` on 5433 and the upstream monorepo's `local-postgres-1` on 5432). If the startup reaper adopts a container that the other install pre-warmed, its baked `HARNESS_SHARED_SECRET` will not match this backend's, and the orchestrator's authenticated calls to it fail. Whether this can happen today depends on whether pool members are namespaced per-install by a Docker label; that needs verification, and if they are not namespaced, this is a real poisoning vector.

### P6 — ENCRYPTION_KEY drift is discovered lazily, per-secret, at the worst time

The `ENCRYPTION_KEY` decrypt errors in the backend log (`A stored secret could not be decrypted … does not match the one it was sealed under`) are all on `GET /environments/connection|provider`, the frontend polling the Environments panel. They are not on the review path; the review's stored subscription token decrypted fine. This is partial, per-secret drift: specific `environment_connections` rows were sealed under a different key and persist in the Postgres volume across a key change, most likely written before the current key existed. It is not caused by any Docker image (`ENCRYPTION_KEY` is host-side and never enters a container).

The root drift is operational, but the way we find out about it is a real gap. Today drift surfaces only when some request or run happens to touch a stale secret, one opaque error at a time, with no boot-time signal and no inventory of what is affected. Two structural reasons, both in `WebCryptoSecretCipher` (`backend/packages/server/src/crypto/WebCryptoSecretCipher.ts`): the `v1.<salt>.<iv>.<ciphertext>` envelope carries a version tag but **no key identifier or fingerprint**, and the per-record random HKDF salt means nothing about a record reveals which master key sealed it short of attempting an AES-GCM decrypt (the auth-tag check is the only signal). So drift can only be learned piecemeal, on access. D6 closes that; the value itself, once sealed under a lost key, is unrecoverable without restoring that key.

### P7 — The browser personal-password cache is not scoped per installation

This is a different key from P6, and the two must not be conflated. `frontend/app/app/stores/personalSubscriptions.ts` caches the signed-in user's personal-subscription **password** in localStorage under a single global key, `CACHE_KEY = 'cf.personal-pw'`, with a 40h TTL, and rides it on gated actions as the `X-Personal-Password` header. That password unlocks the per-user personal token server-side; it is explicitly **not** the at-rest `ENCRYPTION_KEY` (the store's own comment: "the real at-rest protection is the server's system encryption, which the cache doesn't touch"). So it did not cause the P6 drift.

But the cache key is scoped only by browser origin. It carries no installation, workspace, or user discriminator. On this machine two local installs can be served from the same origin (localhost), and a hosted origin can front more than one deployment, so the cached password of one installation is offered to another as `X-Personal-Password`. The failure is not silent corruption (the server rejects a wrong password with a 428 re-challenge), but it is a cross-installation credential reuse in intent and a confusing wrong-password loop in practice. The same global key also means a second signed-in user on a shared browser profile inherits the first user's cached password until it expires or is rejected.

## Decision

Close P1–P4 in the review/observability path, fix P5's pool hygiene, add early detection and guarded remediation for key drift (P6), and scope the browser password cache per installation (P7). Each carries its own design below. They are independent and can land separately.

### D1 — Preserve run history in the failure classifier (fixes P1)

Give `classifyDispatchFailure` (and the eviction-recovery path in `RunDispatcher`) the knowledge that the step had already reached the agent phase. When a run that has begun work fails on a recovery re-dispatch, do not use the "container failed to start" framing. Instead surface an eviction-aware message ("The review container was evicted after N minutes of work and could not be recovered") and set `failureKind: 'evicted'` rather than `'dispatch'`. Carry the last known phase (clone done, agent running) and any partial slice count in the failure detail so the board and the PR-review window can render "work was in progress" rather than "never started." `MAX_EVICTION_RECOVERIES` stays at 1; the change is purely how the terminal state is described and typed.

### D2 — Make the reviewer's execution shape explicit and observable (fixes P2, P3)

The root cause of P2 and P3 is a design assumption (sequential, in-context, TodoWrite-driven slicing) that the current CLI version does not follow (it parallelizes via subagents). Two viable directions; the ADR proposes doing both, in this order:

1. **Surface subagent activity to the harness.** The CLI already writes `subagents/*.jsonl` under the run's config home. Have the harness watch that directory (or request that the parent stream include subagent lifecycle events, if the CLI exposes that) and translate subagent spawn/progress/return into the same `onActivity` and `onProgress` signals the parent stream produces today. This keeps the parallel-subagent shape (which bounds each slice's context well) while restoring progress, the backend heartbeat, and per-slice status. The slice plan can be inferred from subagent `description` fields (`Review <slice> slice`) when no parent TodoWrite plan exists.
2. **Decouple the UI's slicing signal from the todo list.** Replace `isSlicingChunks(subtasks) == empty` with a real signal: either an explicit `slicing`/`reviewing` sub-phase reported by the harness (from D2.1), or a first-class status value. Until slice information exists from either the parent todo list or subagent descriptions, show a neutral "Reviewing (planning slices)…" that does not claim a specific phase, and switch to per-slice status the moment either source produces slices. The UI must never assert "slicing" purely because the parent emitted no todo list.

If we instead decide the reviewer should not parallelize, the alternative is to disallow the Task tool for the `pr-reviewer` kind so it follows the sequential, TodoWrite-driven design the prompt already describes. That restores observability trivially but loses parallelism and the clean per-slice context bound. The ADR recommends D2.1 + D2.2 over disabling subagents, because bounded per-slice context is the behaviour ADR 0023 wanted in the first place.

### D3 — Capture agent token usage incrementally, including subagents (fixes P3 telemetry)

Record `token_usage` as the run progresses rather than only at job end, and include subagent usage. Subagent transcripts carry per-turn usage; if the harness is already tailing them for D2.1, sum their usage into the execution's telemetry as it accrues. This makes mid-run cost visible and stops a long review from looking like zero spend. Attribute subagent usage to the same execution id so billing and the agent-context snapshot are complete.

### D4 — Early cold-start heartbeat check (fixes P4)

Add a short, first-output watchdog distinct from the 10-minute inactivity window: if the agent process produces zero stream bytes within a small window after spawn (for example 90–120s, tunable and safely under clone-inclusive phases), emit a structured diagnostic ("agent produced no output N s after start; possible onboarding/auth wedge") and surface it on the step. This does not kill the run; it makes a genuine wedge legible early instead of waiting out the full inactivity timeout. Pair it with a one-line assertion, after the config-home pre-seed, that the pre-seeded onboarding keys still match the installed CLI's expectations, logged when they do not.

### D5 — Namespace the warm pool per install (fixes P5)

Label every pooled and job container with a per-install identity (for example a stable `cat-factory.install-id` derived from the deployment's config, plus the existing kind labels), and make the startup reaper and the pool adopter filter strictly on that label. A container that lacks this install's id is never adopted; it is left alone (it belongs to another install) rather than reaped or reused. This removes the cross-install poisoning path regardless of how many installs share the Docker daemon, and it makes the reap safe to run without fear of touching a neighbour's containers. Document the label contract in `backend/docs/container-reaping.md`.

### D6 — Detect, surface, and offer guarded remediation for key drift (fixes P6)

Three parts, increasing in cost. They answer the direct question "can we identify drift early, surface it, and propose dropping the stale value" with yes, yes, and yes-but-guarded.

1. **Boot-time drift check via a key fingerprint.** Store a non-secret fingerprint of the master key: `HKDF(masterKey, info="cat-factory:key-fingerprint")` truncated to ~8 bytes, base64. It is a one-way function of the key and leaks nothing usable (you cannot recover a 32-byte key from 8 bytes of HKDF output). Persist it once (local settings) the first time it is computed. On every boot, recompute from the current `ENCRYPTION_KEY` and compare. A mismatch is an O(1), definitive "the key changed since secrets were last sealed" signal, available before any request touches a stale secret. This is the cheap early-warning the incident lacked.

2. **Bounded startup sweep plus a single surfaced issue.** When the fingerprint mismatches (or always, in local mode where the credential count is small), attempt to decrypt each secret-bearing column and bucket the outcome into three cases the cipher already distinguishes: decryptable (fine), AES-GCM auth failure (key mismatch, the drift case), and envelope corruption (the separate truncated/foreign-scheme error). Raise one structured issue or notification that lists the affected credentials by connection type, id, and seal time, never the value, with remediation guidance. This turns a stream of opaque per-request errors into one legible, actionable item in the UI.

3. **Explicit, per-secret drop/re-seal remediation.** Offer an operator action (CLI and the connection UI) that, for a chosen affected credential, drops the unrecoverable ciphertext and flips its owning connection to "needs re-entry," so the app stops throwing on it and the user re-enters it once. This must be opt-in and per-secret, never automatic. If the key was changed by mistake, restoring the original key recovers every value, and an auto-drop would destroy recoverable data. The action states that plainly ("restoring the previous ENCRYPTION_KEY recovers these instead") before it drops anything, and a "drop all stale" batch sits behind the same confirmation.

Forward-looking: adopt a `v2` envelope that embeds the key fingerprint per record, so future drift is classifiable per-record without a decrypt attempt and records sealed under different historical keys are distinguishable. `v1` records carry no fingerprint and continue to need a decrypt attempt; the sweep handles both.

### D7 — Scope the personal-password cache per installation and per user (fixes P7)

Key the cache by discriminators the client already has: the configured API base (`useRuntimeConfig().public.apiBase`, distinct per installation even when the frontend origin is shared) and the signed-in user id. Use `cf.personal-pw:<hash(apiBase)>:<userId>` rather than the bare `cf.personal-pw`. A cached password is then reachable only by the same installation and the same user that entered it; another installation or user on the same origin sees no cache and challenges normally. Per-workspace scoping is not needed and would only add redundant prompts: the backend applies one password to all of a run's individual-usage vendors for a user, so the password is a per-user secret, not a per-workspace one. On read, ignore or migrate any legacy bare `cf.personal-pw` value so the upgrade does not strand a still-valid entry. This is a small, self-contained frontend change and is the browser-layer instance of the same "never reuse a cached secret across installations" hygiene that D5 enforces at the container layer.

## Consequences

- The common case (a healthy, long, parallel-subagent review) becomes legible: progress advances, the heartbeat moves, per-slice status shows, and mid-run token cost is visible.
- A genuinely wedged run surfaces within a couple of minutes instead of ten.
- A run that dies to infrastructure after doing work reports that honestly, so "reruns start broken" stops being the reasonable read of a normal eviction.
- Warm pools stop being a shared-daemon hazard.
- Key drift is caught at boot (the fingerprint) with an inventory of the affected credentials in the scanned sources — currently environment + observability connections, a floor rather than a total (see the deferred note below) — instead of one opaque per-request error at a time, and stale values can be dropped deliberately (never silently, so a mistaken key change stays recoverable by restoring the key).
- The browser password cache stops being reachable across installations or users on a shared origin.
- D2.1 and D3 add a dependency on the CLI's subagent transcript layout. That format is not a stable contract, so the watcher must degrade gracefully (fall back to today's parent-stream-only behaviour) if the layout changes, and it should be covered by a harness test against a recorded transcript fixture.

## Rollout

Independent changes; suggested order by value and blast radius:

1. D1 (small, high value, no behavioural risk). **✅ Landed** — `classifyDispatchFailure` now
   takes the step's run history (`evictionRecoveries`, `startedAt`, partial slice count) and
   frames a container lost after work began as `evicted` with an "evicted after N minutes of work"
   message, not "container failed to start".
2. D2.2 then D2.1 (the reported symptom; D2.2 is a safe UI copy change that stops the false
   "slicing" claim even before D2.1 lands). **✅ D2.2 landed** — the reviewer's no-plan state is a
   neutral `planning` phase ("Reviewing…"), never a "slicing" assertion inferred from an empty
   todo list. **✅ D2.1 landed** — the Claude Code runner derives per-slice progress from the
   parent stream's `Task` dispatches + their tool_results (both DO appear there), so a
   subagent-driven review advances instead of pinning at 0%, and a best-effort watcher tails the
   CLI's `subagents/*.jsonl` transcripts (`subagents.ts`) for the heartbeat + usage. Degrades to
   parent-stream-only behaviour if the transcript layout changes.
3. D6.1 and D7 (both small and self-contained: an O(1) boot drift check, and per-installation
   cache scoping that also closes a cross-install credential-reuse path). **✅ D7 landed** — the
   personal-password cache is keyed `cf.personal-pw:<hash(apiBase)>:<userId>` and the retired
   global key is purged on sight. **✅ D6.1 landed** — a non-secret
   `HKDF(masterKey, "cat-factory:key-fingerprint")[:8]` fingerprint is persisted once in a new
   `key_fingerprint` singleton (D1 + Drizzle, mirrored per runtime) and recompared on every boot
   (Node right after `migrate()`; the Worker on its daily cron), logging a definitive drift signal
   before any request touches a stale secret. `SecretCipher.decrypt` now also throws a typed
   `SecretDecryptError` with a `reason: 'key-mismatch' | 'corrupt'` discriminant — the D6.2
   foundation, so a sweep can bucket a failure without parsing message text.
4. D5 (prevents a class of local-mode failures on multi-install machines). **✅ Landed** — every
   managed local container is namespaced by a secret-derived install id (Docker label /
   Apple name prefix) and the reaper/adopter/enumerations filter strictly on it; see the
   label contract in `backend/docs/container-reaping.md`.
5. D3 and D4 (telemetry and early-wedge diagnostics). **✅ Landed** — D3: the subagent-transcript
   watcher (D2.1) sums each subagent turn's token usage into the run's `usage` + per-call
   telemetry and feeds the heartbeat, so a long parallel review no longer reports ~0 tokens and
   no longer looks wedged; subagent cost lands in `llm_call_metrics` via the existing terminal
   recorder. D4: a short cold-start watchdog (`JOB_COLD_START_MS`, default 120s) records a
   structured diagnostic — without killing the run — when a job produces no output early, plus a
   one-line assertion that the pre-seeded onboarding keys landed, logged with the CLI version.
6. D6.2 (the bounded startup sweep + one surfaced drift issue) and D6.3 (explicit per-secret
   drop/re-seal remediation). **✅ Landed.** Both ride the `SealedSecretInventory` kernel port
   (`listSealed` + `drop`), implemented per runtime (D1 + Drizzle, asserted by
   `defineSealedSecretInventorySuite`) over the two sources the incident named
   (`environment_connections`, `observability_connections`) — extending it to another source is a
   change to the inventory pair, never the sweep. **D6.2:** `sweepKeyDriftAndRaise` (runtime-neutral,
   in `@cat-factory/server`) attempts a decrypt of every sealed secret, buckets each via the typed
   `SecretDecryptError` `reason`, and raises ONE `key_drift` notification per affected workspace
   (listing the affected credentials by source / id / label / reason / seal time, NEVER the value;
   it de-dupes on the affected set and auto-clears once a workspace recovers). It runs at Node boot
   (after the container is built) and on the Worker's daily cron, next to the D6.1 fingerprint
   check. **D6.3:** dropping is explicit + per-secret — the `key_drift` card's action drops every
   credential it lists ("drop all stale"), the `pnpm --filter @cat-factory/node-server
key-drift:drop --source … --id …` operator CLI drops one, and both route through
   `inventory.drop` (env connection → soft-delete tombstone; observability → row delete, since the
   sealed columns are NOT NULL and can't be nulled in place). The value stays unrecoverable, so the
   card + CLI both state that restoring the previous ENCRYPTION_KEY recovers them instead — the drop
   is never automatic.

   **Deferred — inventory coverage is intentionally partial.** The sweep currently scans only the
   two sources the incident named (`environment_connections`, `observability_connections`), not the
   full set of ~15 sealed-secret domains (`provider-api-keys`, `provider-subscriptions`,
   `personal-subscriptions`, `package-registries`, `incident-enrichment`, `test-secrets`,
   `user-secret`, `runners`, `slack`, …). Consequently the surfaced card's count is a FLOOR, not a
   total — its copy reads "at least N" and warns that other credential types may be affected by the
   same key change, so an operator doesn't read it as an exhaustive inventory. This is safe because
   the D6.1 boot fingerprint still detects the key change globally; the per-credential inventory is
   the incremental part. Extending coverage is a change to the `SealedSecretInventory` pair (its two
   repo methods + a conformance seed) plus the drop semantics for the added table (soft-delete vs
   row-delete), never a change to the runtime-neutral sweep.

The immediate `environment_connections` drift on this install is still cleared operationally by re-entering the affected credentials; D6 is what stops the next occurrence from being discovered the hard way.

## Appendix: evidence

- Run `exec_558a81b0`, pipeline `pl_review`, `pr-reviewer`, model `anthropic:claude-opus-4-8`, executor image `1.50.6`, CLI `claude` 2.1.207.
- Injected `.cat-context/pr-diff.md`: 313,886 bytes, "Changed files (518)".
- Folded system prompt: 151,983 bytes (`system prompt exceeds argv limit; folding into the task prompt`).
- Six subagent transcripts under the run's config home; newest 504 KiB, last written 07:19; summed subagent output tokens ≈ 295,165 while `token_usage` held 0 rows for the execution.
- Terminal state: `agent_runs.status = failed`, `error = "The container failed to start."`, `detail.container.status = errored`, `detail.steps[0].prReview.status = reviewing`, `progress = 0`, `slices = []`, `evictionRecoveries = 1`.
- Two Postgres containers on one daemon: `checkbox-cat-factory-postgres-1` (5433) and `local-postgres-1` (5432).

---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Let a provider say WHY an environment is not ready yet, so the readiness ceiling stops reporting only its own duration

`judgeEnvironmentReadiness` formatted the provider's `lastError` into its `timed_out` message, and
`lastError` is structurally always `null` on the one status that can reach that branch. Both
persistence sites write it on `failed` alone and null it otherwise, so every poll that keeps a
readiness wait alive cleared it and any poll that would have filled it settled the wait as `failed`
first. The clause was unreachable, and the platform's whole account of a 20-minute wait was that it
had waited 20 minutes.

The missing thing was not the clause. `ProvisionedEnvironment` had no channel at all for a
non-terminal explanation, so a provider that could name the stage an environment was stuck at had
nowhere to put it. `ProvisionedEnvironment.statusNote` is that channel: one sentence, persisted on
every provision and every poll whatever the status, surfaced in the step's Environment panel while
the run is parked, in the run outcome's environment row, and in the `timed_out` failure detail.

**A sibling field rather than `lastError` widened to every status**, which was the cheaper option
and the wrong one. The note is rendered, and under the error's name a healthy environment
mid-rollout would show an operator a "last error" it does not have. The two are read by different
readers for opposite reasons and only one of them is a fault, so each keeps its own column and its
own label wherever it is shown.

**A recorded fault outranks a note on every reader, and neither is ever dropped for the other.**
The `timed_out` message states both when both are present, fault first, each under its own label.
The Environment panel withholds the note whenever a `lastError` is recorded, whatever the status
(a torn-down environment carries the fault of the failure that preceded it), and says nothing
beside a status that has already left the state a note describes. And where the run OUTCOME's
environment row shows one of them, it says which: `OutcomeEnvironment.detailKind` is `fault` or
`note`, because the two arrive through one slot, read identically as prose, and send a reader to
opposite conclusions. Public API surface 1.63.0, additive.

**The note is bounded where it is written**, not where it is read: provider-authored prose reaches
three surfaces, and a code adapter answering with a controller dump would otherwise push each of
them off screen. A capped note says it was capped.

**The note is the current account, never a log.** It is re-read and rewritten on every poll,
including back to `null`, so a note a provider stops returning stops being stored and cannot outlive
the state it described. A deployment whose providers never set one keeps today's behaviour byte for
byte, including the exact wording of both refusals.

The built-in Kubernetes adapter is the first producer, at the two places it already knew and said
nothing: which Deployments have not finished rolling out (capped, and the cap says it is capped),
and a workload that is healthy behind an Ingress no controller has routed yet, where the ceiling
previously reported a bare twenty-minute wait on an environment that had been up for nineteen of
them. `IngressAdmission`'s `pending` verdict gained the prose that distinguishes its two causes.

Its FAULT channel had the same hole, one status over, and it is closed here too: a rollout that
gave up and a namespace that no longer exists were both reported as the generic `Provisioning
failed` literal, though the reduction computing the verdict was holding the workload's own name.
Both now name what happened.

Watch for: the new `status_note` column lands as a nullable add on both runtimes (D1 migration 0098
and the Drizzle mirror), and the deployer's projection comparison is now derived from the projected
object rather than a hand-listed subset of its fields. During a wait the note is the only field that
moves, so leaving it off the list would have meant the one update the projection exists to deliver
was the one it never pushed; the TTL, provision type and engine beside it were already in that
position, and now a field added to the projection joins the comparison with no second edit.

The Node Drizzle schema's ephemeral-environment tables moved into `db/tables/environments.ts` to
keep `schema.ts` inside its size budget, re-exported so no importer changes.

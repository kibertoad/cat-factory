---
name: framework-gap-request
description: Handle a downstream request to close framework gaps: a consumer build's gap report, an upstream-request spec, or a list of "the seam would not let us do X" findings, given as text, a document path, a URL or an issue reference. Use when asked to triage or act on one ("a consumer hit these gaps", "close the framework gaps in <doc>", "handle this downstream proposal", "here is a gap report from a deployment"). Re-verifies every finding against HEAD, revises it critically against this repo's architecture rules (long-term design over the requester's quick win), lands the tracker or the fix, and opens the PR.
---

# Downstream framework-gap requests

A consumer of the PUBLISHED `@cat-factory/*` packages (an org deployment, a proprietary operation,
another team's build) reports what the framework would not let it do. This intake has run twice and
produced three design records, which are the worked examples used throughout below:
[ADR 0040](../../../backend/docs/adr/0040-deployment-extension-seam-reachability.md),
[ADR 0044](../../../backend/docs/adr/0044-facade-extension-surface.md) and
[ADR 0045](../../../backend/docs/adr/0045-deployment-scoped-documents.md).

Hold one posture the whole way through: **the report is EVIDENCE, never a work order.** The finding
is usually real. The remedy attached to it is the smallest change that would have unblocked the
requester, which is rarely the change the framework should make. Accepting remedies uncritically is
how somebody else's deadline becomes our architecture.

## 1. Ingest

Take the request in whatever form it arrives: pasted text, a path in this repo, a path outside it, a
URL (WebFetch), or an issue (`gh issue view`). Read the WHOLE document before triaging. A summary
drops exactly the details that decide dispositions.

Extract per finding: their id, their claim, their ask VERBATIM, and whatever evidence they gave.
Keep their numbering and assign ours (`S1`..`Sn`) beside it, because they will reply against their
own ids.

Then capture provenance, and ASK for whatever is missing rather than inferring it:

- **Which published versions they measured**, package by package. Every finding is stated against a
  version and this repo moves faster than a consumer upgrades: in the first round one finding of
  nine had shipped one kernel version after the one measured, and in the second round most of the
  report was already closed before it arrived.
- **Which entry point they build against** (`start()`, `startLocal()`, `createWorker()`, the SPA,
  the public API). A seam reachable from one and unreachable from another is itself a finding.
- **What they shipped as a workaround.** The most informative part of any such report: a workaround
  describes the seam the framework should have offered, it becomes the deletion checklist you hand
  back as slices land, and now and then it is simply RIGHT and worth keeping (one consumer's
  two-bodied pointer fragment, whose second body tells the agent the document is missing instead of
  letting absent and empty read the same, is the degrade-loudly rule applied correctly).

## 2. Re-verify every finding against HEAD

Independently, with `file:line` evidence behind each verdict. A finding you cannot cite is not
verified: their references were measured against a published tarball, their reading of our
internals may be wrong, and a report drafted by an agent is wrong in the same confident voice as
one that is right. Past about five findings, verify them concurrently, one investigation per
finding, and keep each verdict with its evidence rather than the search transcript.

Land each on one of these:

- **Confirmed as reported.**
- **Confirmed, but narrower than the defect.** Their instance is one of a class. The most common
  shape, and the reason a report's item count is never the work's item count.
- **Misdiagnosed.** Real symptom, wrong cause, so the remedy that follows from their cause fixes
  nothing.
- **Stale.** Already closed: name the PR and the version, and say whether it shipped after the
  version they measured.
- **Not a gap.** Works as designed, and the behaviour is right.
- **Refused by design.** State the constraint, never the taste.

Whatever turns out fine goes into a **Checked and genuinely fine** section of the artifact so
nobody re-investigates it. Two of the first round's nine landed there, and one was worth writing
into the reference doc as recommended practice.

## 3. Revise it critically

The bar is [CLAUDE.md](../../../CLAUDE.md)'s governing principle: the well-factored design, not the
fastest thing that unblocks the requester. Dispose of the DEFECT and the REMEDY separately, because
"accept the bug, reject the remedy" and "accept, widen the fix" are ordinary outcomes.

Every check below has already changed a disposition on a real report:

- **Audit the class before designing the fix.** The consumer reports the one instance their feature
  needed. In round two that was a single missing registry constructor, and the audit it triggered
  found four more of identical shape, none of which any test could see.
- **Route it through the existing seam**: an app-owned registry injected BY REFERENCE, an option on
  every boot entry point, asserted AT the entry point rather than at the container builder. That
  last distinction was round one's headline bug: the guard graded the builder while the seam was
  unreachable through the door every deployment uses. And an option whose value a deployment cannot
  CONSTRUCT is not a seam either (ADR 0044).
- **Ask any new seam the two standing questions**: does it land symmetrically on every facade, and
  which mothership bucket does it pick? Deployment-registered state that a RUN resolves is org
  state, so it owes the `/internal/*` read rather than a second local copy.
- **Their version pin is not a compatibility obligation.** Internals are pre-1.0: no shim, no
  dual-read, no deprecation window. Name the break in the changeset and tell them the version to
  move to. The reverse holds the moment an ask touches `/api/v1`, the SDKs or the webhook contract:
  additive, or an incremental migration path plus a version change, and never a rename in place.
- **Generalization test.** Would a second, unrelated deployment want this? If only the requester
  would, the answer is their own registration through a seam, and if no seam admits that
  registration, the gap IS the seam.
- **A knob is a decision exported to every deployment.** Refuse one where the platform can defend
  an answer. Grant one where the deployment knows something we cannot:
  `escalateRegistrationWarning` is the worked case, letting the platform keep the severity it can
  honestly defend while a deployment that knows an unresolvable fragment id can only be a typo
  fails boot on it.
- **Where the report says "silently", the silence IS the defect.** A dropped id, an accepted and
  ignored field, a value rendered as live and refused at run time. The fix is to state it, and
  usually not to move the severity. Do not "fix" it by refusing the input at boot when the refused
  shape is the one we tell deployments to use.
- **Documentation findings land first, alone, docs-only.** An unreachable reference doc means part
  of the report is a reconstruction of what that doc already says, so reading it changes other
  items. Docs carry no code risk and sit upstream of everything else.
- **Take no shortcut dressed as pragmatism**: a special case at the call site, a swallowing
  `catch`, a widened `any`, a magic constant, a TODO-shaped half feature. A size budget is a split
  trigger, never a number to raise.
- **Severity is ours to assign.** Blocks a deployment with no workaround, or is silently wrong:
  High. Real with a workaround: Medium. Ergonomics: Low. Their "critical" describes their sprint.
- **A rejection is a design statement.** Name the constraint that makes the ask incoherent and what
  would have to exist first, and scope it as a decision when it is one. The refused `documentRef`
  was not an unsound idea, it was a missing deployment-scoped CREDENTIAL HOME, and saying that
  plainly is what let ADR 0045 build it.

## 4. Land the artifact

**Multi-PR work gets a tracker** (roughly three accepted findings, or one touching both runtimes
plus the SPA) under `docs/initiatives/<slug>.md`, registered in
[the initiatives index](../../../docs/initiatives/README.md). Copy the shape of the tracker that
became ADR 0040:

- A status / owner / started line.
- A **Provenance** blockquote: who built what against which measured versions, that every finding
  was re-verified against HEAD and what that changed, and the companion trackers the items touch.
- **Goal & rationale** naming the recurring FAILURE SHAPES. Round one's nine findings were two
  recurring shapes plus one one-off, and naming the shapes is what stops the next report repeating
  them.
- A **Summary table**: `# | Gap | Severity | Their ask | Disposition`. Their ask stays in it, in
  their words: the distance between that column and the disposition is what a reviewer reads.
- One **section per finding**: what is wrong, with `file:line`, then a numbered "Shape to land".
- A **per-slice checklist** (one PR per slice, scope, dependencies, status, PR link), updated as
  slices land.
- **Conventions & gotchas** (which slice must land first and why, what another initiative is
  waiting on) and **Checked and genuinely fine**.

**A single small accepted finding gets no tracker**: land the fix, its test and the changeset, and
put the disposition in the PR description. Trackers are for multi-PR work.

Either way the revised report is OURS, in our tree and our shape. Do not commit their document
verbatim: it is written against a version that is already aging, and its unrevised remedies would
read as accepted.

Slices then proceed under the normal workflow, and when the committed scope completes the tracker
converts to a numbered ADR (0040, 0044 and 0045 are all such conversions).

## 5. Answer the requester

Write the disposition list in THEIR numbering: accepted with the shape we will land, accepted with
a different remedy plus the reason, rejected with the constraint, stale with the version and PR
that closed it. Add the workarounds they can delete as each slice ships, and what to include next
time (measured versions, the entry point, the failing call).

## 6. PR

Branch, commit, push, open it. A tracker-only change is `docs:`-prefixed with an empty changeset;
code carries a real one naming any internal break.

The description is a reviewer briefing, and its load-bearing half is the asks you REJECTED with the
reason, because a reviewer's first question is why we are not simply doing what the consumer asked.
Name the failure shapes and what the consumer could not do; leave the item-by-item account in the
tracker. Then run the documentation-staleness sweep for whatever the accepted findings changed.

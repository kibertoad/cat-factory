# Role-scoped risk-policy admission

**Goal.** Make WHICH risk policies a caller may select an explicit admission rule, instead of an
accident of which knobs a surface happens to expose.

## Why now

`/api/v1` task create and task PATCH accept `riskPolicyId` as of surface 1.42.0. A risk policy
carries `autoMergeEnabled` and the per-class score ceilings, so choosing one is choosing how much
oversight landing takes. Today any `admin` key may pin any policy its workspace holds.

That is not a regression, which is the point worth being precise about. Before 1.42.0 the same
caller could reach the same outcome by moving the workspace DEFAULT policy, which aims the identical
power at every other task as well. Withholding the field looked like a control and was not one: it
only made the blunt instrument the available one. What was missing then and is still missing now is
a rule that says which policies a given caller may resolve.

The gap has a second half that predates the field entirely. A task created by an API key is
`UNATTRIBUTED_BLOCK_EDIT_AUTHORITY` (ADR 0037): a key holds SCOPES, not a workspace role, so the
role-scoped merge restrictions ([ADR 0037](../../backend/docs/adr/0037-role-scoped-merge-policy.md),
[ADR 0039](../../backend/docs/adr/0039-role-scoped-submission-allowlists.md)) have nothing to match
against and none of them narrow a headless run. A policy's `dryRunRoles` and its per-role submission
allowlist are, for every key-authenticated run, inert. So "which roles may use which risk policies"
cannot be answered for the caller most likely to be automating merges.

## What this has to decide

- **What a KEY counts as.** The three candidate answers are a role carried on the key, the role of
  the user who minted it, or a fourth admission tier that is neither. Each has a different failure
  mode when the minting user later changes role or leaves, and that question is the crux rather than
  a detail: a rule keyed on a role nobody holds any more is a rule that silently stops applying.
- **Where the restriction lives.** On the policy (which roles may resolve it), on the role (which
  policies it may resolve), or as a separate admission table. The policy already carries two
  role-scoped bars, so a third belongs beside them or the vocabulary splits across two places.
- **Which exit enforces it.** The existing bars are refused at BOTH merge exits (auto-merge and
  `mergePr`) rather than at selection, deliberately, because the pin persists and the policy is a
  fact about landing. A selection-time refusal is friendlier and is not a substitute: a policy
  edited after the pin would slip past it.
- **What a refusal says.** A caller that pinned a policy it may not use needs to know that is what
  happened, which argues for a selection-time refusal IN ADDITION to the landing-time one rather
  than instead of it.

## Constraints

- **Narrowing is a public-API break.** Once `riskPolicyId` admits a policy, refusing that same
  policy later takes a migration path and a version step, not a bug-fix release
  ([ADR 0034](../../backend/docs/adr/0034-public-api-stability.md), CLAUDE.md "Narrowing what a
  scope or key may do is a break too"). So the first shipped rule should be permissive by default
  and tightened per deployment, never the reverse.
- **A deployment that configures nothing keeps today's behaviour**, byte for byte. This is a
  governance feature, and an unconfigured governance feature is a pass-through.
- **The merge track record already knows what landed** ([ADR 0046](../../backend/docs/adr/0046-merge-track-record.md)),
  so the rule's effect is observable rather than a claim.

## Out of scope

Model presets. Pinning one is a spend and quality decision bounded by the workspace budget and the
account model-family policy, both of which already refuse independently. Risk policies decide
whether a person looks at the code, which nothing else guards.

The EXISTENCE of a pinned id is also out of scope, and already solved: `BoardService` refuses a
`riskPolicyId` no library carries, at every door into the board. That answers "is this a policy",
where this tracker answers "is it yours to pick".

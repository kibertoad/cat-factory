# What a headless caller cannot read, and therefore cannot act on

- **Status:** open (no slice landed)
- **Owner:** unassigned
- **Started:** 2026-08-25

> **Provenance.** Second report from the consumer behind
> [ADR 0058](../../backend/docs/adr/0058-acceptance-kit-consumer-gaps.md): the Lokalise Kargo
> acceptance suite (`@lokalise/cat-factory-acceptance`), a headless pass against a deployment whose
> environments are Kargo PREnvs served by an environment backend that deployment registers itself.
> The document is round one's, re-issued with closure notes, plus two findings that are new since:
> **K9** and **P5**. Measured against `acceptance-kit@0.3.1`, `@cat-factory/cli@0.13.0`,
> `contracts@0.320.0`, `sdk@0.44.0`; HEAD is `0.4.0` / `0.13.3` / `0.327.0` / `0.46.0`.
>
> **Every closure note in that document was re-verified against HEAD and every one holds** (see
> "Checked and genuinely fine"), so this tracker carries only what is left. Verification changed two
> things. K9 is two asks, and the half the report leads with is already answered and answered
> deliberately, while the half it treats as a footnote is the one nobody has done. And P5's stated
> cause does not exist: nothing validates a `custom` pin, so the defect is not a refusal arriving too
> late but an acceptance that never arrives at all.
>
> **Companion:** [descriptor-driven infra forms](./descriptor-driven-infra-forms.md) owns the SPA's
> side of the same two registries. Slice B publishes a catalog that initiative will also want, so the
> two must project one reduction rather than each growing its own.

## Goal & rationale

Both findings are the same failure shape, which is the one ADR 0058 already named on the `/api/v1`
half ("three of the four findings were about a READ that did not exist") arriving in two new places:

1. **A diagnostic states a conclusion it never checked.** Four published SDK clients render every
   transport failure as `failed to reach <baseUrl>`, which is a claim about reachability made
   without classifying the cause. When the deployment answered nine calls two hundred milliseconds
   earlier, that sentence is the one provably false reading, and it sends the reader to the boot log,
   the database and the CORS config before the transport is suspected.
2. **A write has no catalog and no way back.** A service's `custom` provisioning pin (shipped by
   ADR 0058) can be set by a headless caller that cannot list what is pinnable, cannot learn that
   what it pinned resolves to nothing, and cannot undo the write afterwards.

The platform already holds the rule the first one breaks. `CLAUDE.md` bans a hand-rolled
`e instanceof Error ? e.message : String(e)` precisely because "on Node a transport failure's own
message IS the contentless `fetch failed`, identical for an unreachable host, a bad cert and a DNS
typo", and kernel's `describeConnectionFailure` exists to answer it. The SDKs are the one place that
rule is not applied, and they are the artifact most often read by someone with no checkout.

## Summary

| #  | Gap | Severity | Their ask | Disposition |
| -- | --- | -------- | --------- | ----------- |
| S1 | A `POST` is not replayed after a connection-level failure, so a restart landing on a write ends a pass. | Low | "Retry connection-level failures (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`) a bounded number of times... these are pre-response failures, so a retry is safe." | **Refused by design.** Their premise is wrong for `ECONNRESET`, and the constraint is already stated at `isRetriable`. |
| S2 | Every SDK transport failure renders as `failed to reach <baseUrl>`, with no cause class and no history. | Medium | "When an origin that answered recently stops answering, say so." | **Accepted as asked**, widened to all four clients. Slice A. |
| S3 | A connection failure on `createTask` leaks a task no ledger can name. | Low | (not reported; found while verifying S1) | **Confirmed, deferred.** Not fixable by reordering; the real fix is caller-supplied idempotency, a `/api/v1` decision this tracker will not smuggle in. |
| S4 | A `custom` pin cannot be checked against anything before it is written. | Medium | "A read that publishes the pinnable manifest types... or have the seed register the manifest type alongside the handler." | **Defect confirmed, cause misdiagnosed, first ask accepted and second refused.** Slice B. |
| S5 | A pin cannot be cleared, so a suite permanently mutates a shared board. | Low | "A way to clear a pin (`provisioning: null`, or a `none` variant)." | **Accepted as asked.** Slice B. |

## S1: a `POST` is not replayed, and that is correct

**Refused by design.** `sdk/typescript/src/http.ts:78` already answers this, and answers it with the
right constraint: "a transport failure with no response (status null) tells us nothing about whether
the server acted, so only a method that is idempotent BY DEFINITION may be replayed."

**The report's premise is the part to correct.** It argues the retry is safe because "these are
pre-response failures". That holds for `ECONNREFUSED`, where nothing accepted the connection. It does
not hold for `ECONNRESET`, which is exactly what a process killed *mid-response* produces: the server
may have created the task, started the run and spent the LLM budget, and only the answer was lost.
Retrying it is how one pass files two tasks and pays twice.

Two thirds of the ask are already met, and the report measured a version that had them:
`createPassClient` raises the budget to eight attempts for every one-shot read
(`backend/packages/acceptance-kit/src/client.ts:68`), and `waitForDecisionOrSettled` sits through a
two-minute deployment outage (`deploymentOutage.ts:35`), both landed in #2011 before this document
was written. What is left uncovered is a restart landing on a write, and `client.ts:205` says so
outright.

**No slice.** The answer to the requester is the constraint plus S3.

## S2: the transport diagnostic asserts reachability it never checked

**Confirmed as reported.** `sdk/typescript/src/http.ts:262` builds one message for every
unclassified transport failure:

```ts
throw new CatFactoryConnectionError(
  `cat-factory SDK: ${spec.method} ${spec.path} failed to reach ${this.baseUrl}.`,
  { cause: lastError },
)
```

The other three transports say the same thing: `sdk/python/cat_factory/_http.py:247`,
`sdk/go/errors.go:36`, `sdk/java/.../Transport.java`. The cause chain is attached, so the evidence is
present, but the sentence in front of it is a verdict the SDK did not earn, and a reader who trusts
it goes looking for a deployment that is not running.

Two facts the transport already holds and does not use. It knows the CAUSE, because the thrown value
carries it, and kernel classifies exactly this into eleven cases (`ConnectionFailureCause`), four of
which mean "it was there and may be back" and seven of which are configuration. And it knows the
HISTORY, because the same client instance made the earlier calls: an origin that answered a moment
ago and then reset is a restart, which is a different sentence from an origin that has never
answered.

**Shape to land.**

1. Classify the cause **inside each transport**, self-contained. The SDKs take no dependencies
   (`sdk/typescript/package.json` declares none, by design), so this cannot import kernel. Port the
   vocabulary, do not reach for it.
2. Say which cause it was, and drop the reachability claim when the cause does not support it: a
   reset is `the deployment reset the connection`, a refusal is `nothing is listening at <baseUrl>`,
   a DNS failure names the host that stopped resolving.
3. Carry the client's own history: when this client has completed a call against the origin, add
   when. `answered 9 calls, the last 0.2s ago, then reset the connection` is the whole investigation
   in one line, and it is the sentence the report asked for.
4. Keep `CatFactoryConnectionError` and its `cause` exactly as they are. The class, not the message
   text, is the frozen surface (ADR 0034), so this is additive.
5. Mirror across all four clients. The transports are hand-written beside the generated models
   (`sdk/README.md`), so this is four edits, and `sdk-smoketest` gains the case in all four.

## S3: a connection failure on the create leaks a task nothing can name

**Confirmed, and not reported.** Found while verifying S1.
`backend/packages/acceptance-kit/src/resume.ts:208` is careful about the window it can close:

```ts
const { taskId } = await createTask()
// Recorded BEFORE anything is started: a process killed between the create and the start would
// otherwise leave a task on the board that no ledger names and no resume can find.
onRecord({ taskId, runId: null, pullRequestUrl: null, answeredKinds: [] })
```

The window it cannot close is one line earlier. If `createTask()` throws after the deployment created
the row, the id never reaches the client, so there is nothing to record and the next pass files a
second task. This is `resume.ts`'s own rule ("record the moment a state is ENTERED") meeting the one
state a client cannot observe itself entering.

**Deferred, with the reason.** The honest fix is a caller-supplied idempotency key on the `/api/v1`
writes that cost real work, which is a permanent shape on a frozen surface and deserves its own
decision rather than a corner of a diagnosability tracker. Blast radius today is one stray task on a
board with no run started and no budget spent, which is why it is Low. S2 removes the part that
actually hurts, which is not knowing this is what happened.

**Shape to land now:** one rule in the kit README beside the existing eight, naming the window and
what a resumed pass sees.

## S4: a `custom` pin is checked against nothing

**The defect is real. The stated cause is not.** The report says the pin is "validated against the
deployment's custom-manifest-**type** registry" and refuses "at the end of a scenario, with a whole
`pl_build` run already paid for". There is no such validation. The write path is
`PublicProvisioningController.ts:831` to `toBlockPatch` to `mergeProvisioning` to
`BoardService.updateBlock`, and none of them reads a registry: `publicManifestIdSchema`
(`contracts/src/public-provisioning.ts:89`) checks a string format and nothing else.

So an id no handler serves is **accepted**, and the failure surfaces later, at the deployer step,
where `infra-handler.logic` answers `no-handler`. That is the worse half of the same family: the
report's own §K5 rule, that absent and broken must not render alike, applied to a write that reports
success for a pin that will never resolve.

**The second ask is refused, and the two-registry split it complains about is correct.**
`createEnvironmentHandlerSeeder` writes `environment_connections` rows;
`CustomManifestTypeRegistry.register` takes a `RegisteredCustomManifestType` carrying `detect()` and
`fixerPrompt`, which are CODE. One is data a mothership can serve over RPC and the other is functions
that only exist in the process holding them. Making a seed fill both would mean either a seed that
cannot express a detector or a registry that cannot be seeded, and the split is what keeps each
honest.

**Refusing the pin at the write is also refused**, and this one is closer. It would be the cleanest
statement of the defect, but it narrows what a live integration may write, which ADR 0034 treats as
a break needing a migration path rather than a fix. A caller pinning ahead of a registration is
admitted today.

**Shape to land** (the report's first ask, which is additive and sufficient):

1. `GET /api/v1/environments/manifest-types`, projecting
   `EnvironmentConnectionService.listCustomTypes(workspaceId)`
   (`integrations/.../EnvironmentConnectionService.ts:470`), which already merges the code-registered
   types with the workspace rows. No new repository method, so no new mothership bucket:
   `customManifestTypeRepository.listByWorkspace` is already `remote` (`rpc-allowlist.ts:704`).
2. Publish `manifestId`, `label`, `source` and `defaultManifestPath`. Not `fixerPrompt`, not
   `acceptsInputHint`: a prompt is internal text this repo rewrites freely, and freezing it buys a
   caller nothing.
3. Register it in `scripts/sdk/surface.mjs` under the `environments` group, and refresh that group's
   description, which still describes only the probe and the bind.
4. Joined with the handler list ADR 0058 shipped, this is what lets a gate refuse before spending,
   which is what the requester asked for.

## S5: a pin cannot be cleared

**Confirmed.** `updatePublicServiceSchema.provisioning` is
`v.optional(publicServiceProvisioningSchema)` (`contracts/src/public-provisioning.ts:711`), and the
variant has two members, neither of which means "none". Omitting the key leaves the stored pin alone,
which is right and documented, so there is no value that clears one. A suite that pins a frame
changes it permanently, and this suite re-adopts the same frame across passes by design.

**Shape to land.**

1. Accept `provisioning: null` as CLEAR. Omitted keeps its current meaning exactly, which is the
   property the field's doc comment defends: a caller correcting a title must not un-deploy a
   service.
2. Additive under ADR 0034: a value previously rejected becomes accepted, and no shape changes.
3. `toBlockPatch` lowers `null` to a provisioning-clearing block patch; conformance asserts a cleared
   service reads back with no `provisioning` on both facades.

## Slices

| # | Slice | Scope | Depends on | Guard | Status | PR |
| - | ----- | ----- | ---------- | ----- | ------ | -- |
| A | Classify the SDK transport failure | S2 across all four clients, plus the kit README rule for S3 | none | `sdk-smoketest` case in all four clients; a unit test per transport asserting a reset and a refusal render differently | not started | |
| B | The `custom` pin's missing halves | S4 read + S5 clear, contracts, controller, `surface.mjs`, regenerated clients, OpenAPI minor | none | conformance: a pin to an unserved id is listable-against; a cleared pin reads back absent | not started | |

A and B are independent and either may land first.

## Conventions & gotchas

- **The SDKs take no dependencies, and that is deliberate.** Slice A cannot import
  `@cat-factory/kernel`. Port the cause vocabulary into each transport and pin the agreement with a
  test rather than reaching across the boundary.
- **Only models and operations are generated.** Each transport is hand-written (`sdk/README.md`), so
  slice A is four real edits and no emitter change. Slice B is the opposite: change the contracts and
  `surface.mjs`, then regenerate, and never hand-edit a file whose header says GENERATED.
- **A new `/api/v1` endpoint without a `surface.mjs` entry fails generation.** That is the guard doing
  its job, not a build break to work around.
- **Do not narrow the pin write.** It is the obvious fix and it is a public-API break (S4).
- **Slice B bumps the OpenAPI `info.version` minor**, both changes being additive.

## Checked and genuinely fine

- **Every closure note in the report holds.** K1 (`acceptance-kit/src/resource.ts`), K2
  (`PassOptions.onSettled`, `pass.ts:93`), K3 (`unknown`, `preflight.ts:141`; `Prerequisite.probe`,
  `preflight.ts:105`), K4 (`ConfigProblem` re-exported, `index.ts:46`), K5 (no "namespace" left in
  `evidence.ts`), K6 (`briefFields`, `brief.ts:74`), K7 (`./console-credential` subpath in the
  manifest), K8 (`mergeEnvFile` and its four siblings exported from `cli/src/index.ts`), P1 service
  half, P2 (`/api/v1/environments/connections`), P3 (`repos/{owner}/{name}/contents`). Re-verified on
  HEAD; nothing to redo.
- **P1's connection half stays declined** on ADR 0058's stated reason (an open `providerConfig`
  cannot land on a frozen surface). The report accepted it and this round does not revisit it.
- **P4 is closed too**, though the report lists it as asking for nothing: the merger's branch deletion
  is rule 8 in the kit README, which is the line it wanted.
- **`customManifestTypeRegistry` is read locally on a mothership node, and should be.** Four sibling
  code-registered catalogs ride an `/internal/*` read (`agent-kinds`, `binary-generators`,
  `foundational-services`, `prompt-fragments`) and this one does not, which looks like the fifth
  instance of that class. It is not. Its entries carry `detect()` and `fixerPrompt`, and its two
  readers (`EnvironmentConnectionService.ts:733` and `:967`) run those hooks in the node's own
  process. A catalog of functions cannot ride an RPC, and the workspace ROWS beside it already route
  remotely. Recorded so the next audit stops here rather than re-deriving it.

# ADR 0060: What a headless caller could not read, and what we published instead

- **Status:** Accepted (implemented)
- **Date:** 2026-08-25
- **Context layer:** the four `sdk/*` transports, the `/api/v1` provisioning surface, and
  `@cat-factory/acceptance-kit` as their headless consumer.

## Context

The consumer behind [ADR 0058](./0058-acceptance-kit-consumer-gaps.md), a headless Kargo acceptance
suite built on the published `@cat-factory/*` packages, re-issued its gap report: round one's
document with closure notes, plus two findings that were new since. Every closure note in it held on
HEAD, so what was left was the two new ones, and verification moved both.

**K9 was two asks, and the report led with the wrong one.** It asked for connection-level retries on
writes, arguing they are safe because "these are pre-response failures". That is true of
`ECONNREFUSED` and false of `ECONNRESET`, which is exactly what a process killed mid-response
produces: the deployment may have created the task, started the run and spent the budget, with only
the answer lost. The read-side and poll-side halves of the ask had already shipped. The half nobody
had done was the footnote: four published SDK clients rendered every transport failure as
`failed to reach <baseUrl>`, a reachability verdict made without classifying the cause.

**P5's stated cause did not exist.** The report said a `custom` provisioning pin is validated against
the manifest-type registry and refused late, after a `pl_build` run is paid for. Nothing validated
it: the write path reads no registry, so an id no handler serves was accepted and only failed at the
`deployer` step. The defect was real and worse than described, which changed what fixes it.

Both are the failure shape ADR 0058 already named on the `/api/v1` half ("three of the four findings
were about a READ that did not exist"), arriving in two new places: a diagnostic that states a
conclusion it never checked, and a write with no catalog and no way back.

## Decision

### The SDK transports classify the failure and state what they know

All four clients (TypeScript, Python, Go, Java) build the message from three parts: what happened,
what that client had already seen from the origin, then the runtime's own cause chain, verbatim.

- The cause vocabulary is a PORT of kernel's `ConnectionFailureCause`, not an import of it: the SDKs
  declare no dependencies by design. Each transport carries its own copy, matched against the codes,
  exception types and errnos its own runtime produces, and each is pinned by a per-language test.
- Every sentence states only what its cause supports. A refusal names a port with nothing behind it,
  a reset names an origin that WAS there, a DNS failure names the host, and a request rejected before
  a socket was opened claims nothing about the origin at all. An unrecognised chain answers as
  itself rather than being guessed onto a cause.
- The client's own history is part of the message, in both directions: "had answered 9 calls, the
  last 0.2s ago" is a deployment that restarted, and "has not completed a call yet" is what points at
  the address rather than at the deployment. A response of ANY status counts as an answer, because a
  500 is still proof the origin is there.
- The error CLASS and its cause are untouched, which is what makes this additive on a frozen surface:
  the message text was never the contract.

### The `custom` pin gains its two missing halves

- **`GET /api/v1/environments/manifest-types`** publishes every id a `custom` pin may name, both
  tiers as one list, projected from the same `EnvironmentConnectionService.listCustomTypes` the app's
  own inspector reads. It publishes `manifestId`, `label`, `source` and `defaultManifestPath`, and
  not `fixerPrompt` or `acceptsInputHint`.
- **The service provisioning variant gains an `infraless` member**, which
  `PATCH /api/v1/services/{serviceId}` accepts to TAKE A PIN BACK. Omitted keeps its existing
  meaning exactly (the stored pin is left alone), and a member previously rejected becomes accepted,
  so nothing a consumer sends today changes meaning. It is lowered onto the stored column as the
  type that MEANS none rather than as a deleted key, because the patch replaces that column
  wholesale, and it is the one member that does not overlay what is stored: the remainder belongs to
  the engine being left behind.
- **The undo is a MEMBER rather than a `provisioning: null`.** A null-valued OPTIONAL field is not
  expressible from the Go, Java or Python clients: each drops one when serializing (`omitempty`,
  `@JsonInclude(NON_NULL)`, `if ... is not None`), and Go cannot reach for `omitzero` while the SDK
  is pinned at Go 1.23. A field where absent and null must mean different things is therefore a
  shape only the TypeScript client can drive, so `/api/v1` does not have one: where a surface needs
  a third state, it gets a named member. A named member also says what the service BECOMES rather
  than only what it stops being, which answers the variant's own complaint that neither of its two
  members meant "none".

## Rationale

**Retrying writes was refused**, which was the requester's headline ask. The constraint is stated at
`isRetriable` and it is right: a transport failure with no response says nothing about whether the
server acted, and retrying is how one pass files two tasks and pays twice.

**Making the handler seed register the manifest type too was refused.** The two registries hold
different kinds of thing: one holds rows a mothership serves over RPC, the other holds `detect()` and
`fixerPrompt`, functions that only exist in the process holding them. A seed that filled both could
not express a detector.

**Refusing an unresolvable pin at the write was refused**, and it is the closest call here. It is the
cleanest statement of the defect, and it narrows what a live integration may write, which
[ADR 0034](./0034-public-api-stability.md) treats as a break needing a migration path rather than a
fix. The additive read gets the requester what they need: a gate that refuses before it spends.

**P1's connection half stays declined** on ADR 0058's original reason (an open `providerConfig`
cannot land on a frozen surface).

## Consequences

- The SDK message text is now assembled rather than fixed, so a consumer asserting on the old
  sentence sees a different one. That text was never part of the contract, and the class, the status
  fields and the cause chain are unchanged.
- The transports each carry a copy of the cause vocabulary. Kernel's list moving is not
  automatically reflected in them; the per-language tests are what state the agreement, and a
  vocabulary change owes the four copies an edit.
- One `/api/v1` endpoint and one accepted-value widening, both additive: OpenAPI `info.version`
  1.61.0, and the four generated clients plus the MCP projection regenerate with them.
- **A window this does not close**, recorded rather than fixed: `fileAndDrive` records a task id on
  the line after the create and cannot close the window one line earlier. If the create's response is
  lost, the id never reaches the client and the next pass files a second task. The honest fix is
  caller-supplied idempotency on the `/api/v1` writes that cost real work, which is a permanent shape
  on a frozen surface and deserves its own decision. It is rule 9 in the kit README, and the SDK
  diagnosis above is what tells this apart from a create that never landed.
- **`customManifestTypeRegistry` stays read locally on a mothership node**, unlike the four sibling
  code-registered catalogs that ride an `/internal/*` read. Its entries carry `detect()` and
  `fixerPrompt`, and its readers run those hooks in the node's own process: a catalog of functions
  cannot ride an RPC, and the workspace ROWS beside it already route remotely. Recorded so the next
  audit stops here rather than re-deriving it.

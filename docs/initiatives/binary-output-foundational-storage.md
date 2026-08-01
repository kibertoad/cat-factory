# Binary outputs stored through foundational services

**Goal.** Let a deployment run agent kinds whose deliverable is BINARY artifacts — image
generation is the canonical example — stored through a foundational service the org already runs,
and scoped by other foundational services that know the domain (an entity inventory that can say
what exists, what lacks an image, and how each thing is described).

**Why this shape.** The platform's own binary-artifact store
(`BinaryArtifactStore`, the `binary-storage` TRAIT) holds run EVIDENCE — the UI Tester's
screenshots, read back by the visual-confirmation gate. A generated product asset is not evidence:
it belongs in the org's own storage, addressed the org's own way, found by the org's own systems.
The foundational-services catalog ([`foundational-services.md`](./foundational-services.md))
already models exactly that — a registered shared capability with an API contract — so this
feature is a third read off that catalog, not a second storage subsystem.

## Model

- **A generator opts in by TRAIT, never a kind-id list**: `registerAgentKind({ traits:
['binary-output'] })` (`BINARY_OUTPUT_TRAIT`, `@cat-factory/agents`). No built-in kind carries
  it. The trait contributes the workflow guidance (consult scope first, store through the named
  service's contract, never commit binaries to the repo, declare what you stored).
- **The step selects the services** — `stepOptions.binaryOutput`:
  - `storageServiceId` — the catalog service every artifact is stored through. Must carry the
    **`binary-storage` capability tag** (`BINARY_STORAGE_CAPABILITY`, kernel), because pushing
    product assets into the org's audit service is a configuration error, not a judgment call
    left to the agent.
  - `contextServiceIds` — catalog services consulted for generation SCOPE. Existence is
    enforced; no tag is, since any service with a readable contract can inform scope. The
    conventional tag `generation-context` (`GENERATION_CONTEXT_CAPABILITY`) exists for pickers,
    not for enforcement.
- **Two refusal layers**, split exactly like the skill-step precedent:
  - PRESENCE is structural — `assertValidBinaryOutputSteps` in `validatePipelineShape`, so a
    generator step with no selection is a 422 at pipeline save AND run start.
  - RESOLUTION is admission — `RunAdmission.assertBinaryOutputSelected` re-validates the ids
    against the RESOLVED catalog at every start/retry/restart (the catalog can change after
    save), refusing 409 `binary_output_service_invalid` with `details.serviceId` /
    `details.problem` (`unknown_service` | `not_storage_capable`) / `details.role`.
- **The dispatch injects `.cat-context/binary-output/`** (`run-binary-output.ts`, a sibling of
  `run-foundational-services.ts` off the SAME resolver, so one tier merge and one cache):
  `brief.md` naming the storage + context services concretely, plus one contract file per
  resolved service (`renderContractDocument`, reused). The brief STATES every gap — no selection,
  an id the catalog lost since admission, a service with no registered contract — and the trait
  guidance names the brief's ABSENCE as "storage could not be provided: do not upload, report" —
  so every failure degrades into a stated refusal rather than a guessed endpoint.
- **The declaration is the read-back** — the agent ends its reply with a fenced
  ` ```binary-outputs ` block: `none`, or a JSON array of
  `{ service, location, entity?, contentType?, description? }`. `parseBinaryOutputDeclaration`
  (kernel) parses it once, at step settlement (`job-facts.ts`, before every early-returning
  completion path), onto `PipelineStep.binaryOutputs`. Bookkeeping is degrade-loudly throughout:
  `undeclared` (no block) ≠ empty `stored` (declared none) ≠ `parseFailed`; malformed entries are
  COUNTED (`invalidEntries`), over-cap entries are COUNTED (`omitted`), and a service id the
  catalog does not know is NAMED (`unknownServices`) while its entries are retained — the
  platform records the claim, a reader judges it against the configured target.

## The difference from the foundational-services reads

The catalog/contracts pair joins a DESIGN's declaration to its CONSUMERS: the architect chooses,
downstream kinds inherit. A binary-output step's join is its OWN step options — a human (or
pipeline author) selected the storage and scope services up front, so there is no declaration to
wait for and admission can validate the whole selection before anything dispatches.

## Runtime symmetry & mothership

Nothing new is persisted: the selection rides the pipeline/step JSON (`stepOptions`), the report
rides the step (`binaryOutputs`), and every read goes through the existing
`FoundationalServiceCatalogService` methods — already conformance-covered and already in the
`remote` RPC bucket — so both facades and mothership mode are correct by construction.

## How credentials reach the agent

They don't, through this feature. The contract tells the agent HOW to call the storage service;
whether it CAN authenticate is the existing capability seams' job (a tool server with a
`ToolSecretResolver`-named secret, or test secrets), and a missing credential follows the standing
rule — stated to the agent, which reports the gap as a named omission instead of silently
dropping artifacts.

## Remaining work

- [ ] **SPA pipeline-builder picker.** The REST/pipeline API carries `stepOptions.binaryOutput`;
      there is no Vue picker yet. It belongs beside the variant/skill step options, listing the
      workspace's resolved catalog filtered to `binary-storage`-tagged services for the storage
      half (and `generation-context`-tagged first for the context half). Blocked in practice on
      the foundational-services management SPA, which is itself still pending
      ([`foundational-services.md`](./foundational-services.md) → Remaining work).
- [ ] **Step result view.** `PipelineStep.binaryOutputs` is recorded but no result window renders
      it; a small panel listing the stored artifacts (and the unknown-service / invalid-entry
      warnings) belongs in the `resultViews` slot.
- [ ] **A worked example generator** in `backend/internal/example-custom-agent`, once a real
      image-generation harness path exists to demonstrate against.

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` it in the same PR.

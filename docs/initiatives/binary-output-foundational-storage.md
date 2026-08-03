# Binary outputs stored through foundational services

**Goal.** Let a deployment run agent kinds whose deliverable is BINARY artifacts — image
generation is the canonical example — produced through generative integrations the deployment
registers in code (an image / music / video API such as Retro Diffusion), stored through a
foundational service the org already runs, and scoped by other foundational services that know the
domain (an entity inventory that can say what exists, what lacks an image, and how each thing is
described).

**Why this shape.** The platform's own binary-artifact store
(`BinaryArtifactStore`, the `binary-storage` TRAIT) holds run EVIDENCE — the UI Tester's
screenshots, read back by the visual-confirmation gate. A generated product asset is not evidence:
it belongs in the org's own storage, addressed the org's own way, found by the org's own systems.
The foundational-services catalog
([ADR 0031](../../backend/docs/adr/0031-foundational-services.md)) already models exactly that — a
registered shared capability with an API contract — so this feature is a third read off that
catalog, not a second storage subsystem.

## Model

- **A generator opts in by TRAIT, never a kind-id list**: `registerAgentKind({ traits:
['binary-output'] })` (`BINARY_OUTPUT_TRAIT`, `@cat-factory/agents`). No built-in kind carries
  it. The trait contributes the workflow guidance (consult scope first, store through the named
  service's contract, never commit binaries to the repo, declare what you stored).
- **The step selects the services and the INTEGRATIONS** — `stepOptions.binaryOutput`:
  - `storageServiceId` — the catalog service every artifact is stored through. Must carry the
    **`asset-storage` capability tag** (`ASSET_STORAGE_CAPABILITY`, kernel), because pushing
    product assets into the org's audit service is a configuration error, not a judgment call
    left to the agent. The tag is deliberately NOT spelled `binary-storage`: that is the agents
    package's `BINARY_STORAGE_TRAIT`, a marker on a KIND that needs the PLATFORM's artifact store
    for run EVIDENCE — the opposite claim about a different subject. While they shared one
    literal, `RunAdmission` imported both, a capability tag is a free-form string so a swap
    typechecked, and no behavioural test could tell. `binary-output-vocabulary.test.ts` in
    `@cat-factory/agents` — the only package that sees both vocabularies — pins them apart.
  - `contextServiceIds` — catalog services consulted for generation SCOPE. Existence is
    enforced; no tag is, since any service with a readable contract can inform scope. The
    conventional tag `generation-context` (`GENERATION_CONTEXT_CAPABILITY`) exists for pickers,
    not for enforcement.
  - `generatorIds` — the GENERATIVE INTEGRATIONS the step may call to produce the artifacts,
    from the deployment's code-registered `BinaryGeneratorRegistry` (see the section below).
    Absent ⇒ the step generates through whatever its agent already has, and the brief says so.
  - `modalities` — the CONTENT TYPES the step must deliver. Every one must be covered by a
    selected integration. It is deliberately not defaulted from the selection: "this step
    delivers audio" is a statement about the WORK, and deriving it would make removing the audio
    integration look like a change of requirements rather than a break.
- **Two refusal layers**, split exactly like the skill-step precedent (the generative half adds a
  third refusal under its own reason — see below):
  - PRESENCE is structural — `assertValidBinaryOutputSteps` in `validatePipelineShape`, so a
    generator step with no selection is a 422 at pipeline save AND run start.
  - RESOLUTION is admission — `RunAdmission.assertBinaryOutputSelected` re-validates the ids
    against the RESOLVED catalog at every start/retry/restart (the catalog can change after
    save), refusing 409 `binary_output_service_invalid` with `details.serviceId` /
    `details.problem` (`unknown_service` | `not_storage_capable`) / `details.role` as the
    headline, plus `details.issues` — EVERY unresolved id, not just the first. Surfacing one at a
    time would cost a refuse-fix-restart round per lost service; the message
    (`describeBinaryOutputConfigIssues`, kernel) names the whole fix.
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
  completion path), onto `PipelineStep.binaryOutputs`. The block is found by the shared
  `extractFencedDeclaration`, which takes the **LAST** match: the guidance says to END the reply
  with it, and a model that illustrates the shape first would otherwise have its example parsed
  and its answer discarded — reporting "stored nothing" about a run that stored things, which is
  worse than reporting nothing at all. The foundational-services parser reads through the same
  helper, so the rule holds for both. Bookkeeping is degrade-loudly throughout:
  `undeclared` (no block) ≠ empty `stored` (declared none) ≠ `parseFailed`; malformed entries are
  COUNTED (`invalidEntries`), over-cap entries are COUNTED (`omitted`), and a service id the
  catalog does not know is NAMED (`unknownServices`) while its entries are retained — the
  platform records the claim, a reader judges it against the configured target.

## Injection asks the effective kind; the read-back asks the step

The two halves cannot ask the same question, and the asymmetry is where records get lost.
Injection runs at DISPATCH and keys off the EFFECTIVE kind, which it is handed — a gate helper
or a PR-review override kind dispatches under its own kind, not `step.agentKind`. The read-back
runs on the durable completion path, which rebuilds everything from the STEP alone and therefore
cannot know which kind actually ran.

So `stepMayDeclareBinaryOutputs` is the UNION, both halves derivable from the step: its own kind
carries the trait, OR it carries a `binaryOutput` selection — the only thing a brief is ever
built from, so its presence means some dispatch here was briefed. Asking only
`hasTrait(step.agentKind)` silently drops the declaration of every trait-carrying kind dispatched
under an overriding kind: the artifacts exist, the step's record says nothing was stored, and
nothing errors. A step with neither was never briefed, so a block in its reply is a coincidence.

(The sibling foundational recorder still keys on `step.agentKind` alone. That is correct for it
today — no overriding kind carries `foundational-catalog` — but it is the same latent shape, so
it is worth revisiting if a deployment ever registers a design-capable gate helper.)

## The difference from the foundational-services reads

The catalog/contracts pair joins a DESIGN's declaration to its CONSUMERS: the architect chooses,
downstream kinds inherit. A binary-output step's join is its OWN step options — a human (or
pipeline author) selected the storage and scope services up front, so there is no declaration to
wait for and admission can validate the whole selection before anything dispatches.

## The generative half: registering the integrations

Storage answers where an artifact GOES. Nothing answered what MAKES it, so a deployment could
register a generator KIND and a place to put its output while the API that actually renders the
image stayed a thing the agent had to be told about in prose — with its key nowhere.

`BinaryGeneratorRegistry` (kernel, app-owned exactly like `FoundationalServiceRegistry`) closes
that. A deployment registers its integrations in CODE:

```ts
binaryGenerators.register({
  id: 'retro-diffusion',
  name: 'Retro Diffusion',
  summary: 'Pixel-art image generation.',
  description: 'Sprites, tiles and item art. Not for photorealism or text-heavy images.',
  modalities: ['image'],
  mediaTypes: ['image/png'],
  endpoint: 'https://api.retrodiffusion.ai/v1',
  guidance: 'Inference is synchronous; the response carries base64 images in `base64_images`.',
  credential: { key: 'RD_TOKEN', usage: 'the X-RD-Token request header' },
  contracts: [{ contractId: 'api', format: 'openapi', title: 'Inference API', body: OPENAPI }],
})
```

**Why its own registry rather than a capability tag on the foundational catalog.** The catalog is
what a DESIGN is expected to consume — the Architect is shown all of it for exactly that purpose —
and a metered vendor API that makes pictures is not something to design against; it is an
instrument a specific step is pointed at. Their lifecycles differ too: the catalog is tiered,
tenant-editable state with rows behind it, while an integration is deployment code with a
credential attached. What they DO share is the contract vocabulary (`uploadApiContractSchema`) and
the renderer, so an agent reads one kind of contract file whatever registry it came from.

### Content types are a closed vocabulary

`BinaryModality` is `image | audio | video | 3d | document`, closed where the catalog's capability
tags are free-form. Three things depend on it and none tolerates a near-miss: the coverage check
at admission, the brief's grouping (what keeps a step holding an image generator AND a music
generator from asking one for the other's output), and the SPA picker. `images` vs `image` would
be two content types that look identical to a reader and silently never match — the failure
`reservedCapabilityNearMiss` exists to catch for the tags that must stay free-form.

The members are MODALITIES, not genres: music, speech and sound effects are all `audio`, because
what differs between them is the prompt while what differs between audio and video is the whole
integration. A deployment telling a music generator from a speech generator says so in
`mediaTypes` and the description. `mediaTypes` are validated against the declared modalities at
BOOT — a recognised media type contradicting them is an error, an unrecognised one is not (the
classifier is not a registry of every format that exists).

### Refusal, again in two layers, but against two different registries

`binaryGeneratorSelectionIssues` is checked at admission alongside the storage-side one, and
refuses under its OWN reason, `binary_output_generator_invalid`: `unknown_generator` (an id this
build does not register) or `modality_uncovered` (a content type the step declares that nothing
selected produces). Keeping it apart from `binary_output_service_invalid` is not tidiness — a
storage id is fixed in the workspace catalog by whoever runs the board, an integration id is fixed
in the deployment's own build, and one reason would send half the readers to the wrong place. It
also runs with NO catalog seam wired, since the registry needs no I/O.

### The credential: declared by name, delivered per job, never to a prompt

This is the one place the feature's original "credentials reach the agent through the existing
seams" answer did not hold. A tool server's credential works because the platform configures the
client; an image API is called by the agent's OWN code, so the value has to be in that job's
environment or the integration is decorative.

So a definition declares the credential BY NAME and the value takes the same route a tool server's
does, one channel over:

1. the ENGINE resolves the selection onto `AgentRunContext.binaryGenerators` — ids, content types
   and the credential's KEY NAME, all non-secret, which is why the agent-context snapshot may
   record it;
2. the CONTAINER EXECUTOR resolves the values through the kernel `ToolSecretResolver` port (the
   facade's, so a deployment needing per-workspace keys implements the port and nothing else
   changes) and writes them to the job body's `generatorSecrets`;
3. the HARNESS layers them onto THAT JOB's agent env — never `process.env`, which the shared
   native host process makes a cross-job leak — and registers each value for redaction.

`ToolSecretResolver`'s input gained a discriminated `subject` (`tool-server` | `binary-generator`)
because two registries mint these ids and nothing stops them colliding: a deployment with a
`retro-diffusion` tool server AND a `retro-diffusion` integration would otherwise hand each the
other's secret from a per-workspace store.

**An unresolvable credential is not a failed dispatch.** The brief states, per integration, that
an unset variable means the platform could not provide the key and the integration must not be
called — and the agent can SEE the variable, so a second declaration from the executor could only
agree with the environment or contradict it. A run that generates what it can and NAMES the gap
beats one that refuses to start over the most ordinary misconfiguration there is.

### The brief leads with generation

`renderBinaryOutputBrief` is now three sections in the order the work happens: **Generation**
(each integration's content types, formats, endpoint, notes, credential variable and contract
file), **Scope**, **Storage**. What makes the artifacts is the decision an agent cannot recover
from later, and a generator that reads only the top of the file must still get it right. Every gap
is stated rather than omitted — an id the deployment no longer registers, a content type nothing
available produces, an integration with no contract — and the read-back records `generator` per
artifact with `unknownGenerators` kept apart from `unknownServices`, for the same
different-registry reason the refusals are.

## Runtime symmetry & mothership

Nothing new is persisted: the selection rides the pipeline/step JSON (`stepOptions`), the report
rides the step (`binaryOutputs`), and every read goes through the existing
`FoundationalServiceCatalogService` methods — already conformance-covered and already in the
`remote` RPC bucket — so both facades and mothership mode are correct by construction.

The generative half is stronger still: the registry is in-process composition data with no
repository behind it, so there is no method to route, nothing to allow-list, and a mothership-mode
node reads the SAME definitions its own build carries. (That is also its one limitation: unlike
the catalog's `builtin` tier, an integration a node's build does not have is simply not there —
which is correct, since the node is where the agent's job body is assembled.)

## How credentials reach the agent

For the STORAGE service, they still don't, through this feature. The contract tells the agent HOW
to call it; whether it CAN authenticate is the existing capability seams' job (a tool server with
a `ToolSecretResolver`-named secret, or test secrets), and a missing credential follows the
standing rule — stated to the agent, which reports the gap as a named omission instead of silently
dropping artifacts.

For a GENERATIVE INTEGRATION they do, and the section above says why the storage answer could not
be reused: the platform configures a tool server's client, while a generation API is called by the
agent's own code. If the storage half ever needs the same, it should ride the same three-step
channel rather than a second one.

## The SPA surfaces

Both landed together. What each is, and the one design question the downstream proposal that
prompted them got wrong.

### The read surface is a shared SECTION, not a declared result view

`PipelineStep.binaryOutputs` is rendered by `BinaryOutputReport.vue`, resolved from the ACTIVE
STEP in two places: `ResultWindowShell`'s trailing sections (beside the effort and pre-PR
validation sections, so no result window can opt out of it) and `AgentStepDetail`, the generic
panel a step whose kind declares no result view opens instead — the shell is not involved there,
so both are needed and neither is a duplicate of the other.

**It is deliberately NOT a `presentation.resultView` a generator kind declares.** That was the
proposal's shape, and it cannot cover the record's own scope: `stepMayDeclareBinaryOutputs` is the
UNION (the step's kind carries the trait, OR the step carries a selection), precisely so a
trait-carrying kind dispatched under an OVERRIDING kind still has its artifacts recorded. A
kind-declared view is by construction blind to that case — the step's own kind declares some other
window, and the artifacts exist with nothing showing them. Three further things fall out of
resolving off the step instead: a deployment registers nothing (no id, no component, no
`RESULT_VIEW_IDS` entry); a generator stays free to declare a result view for its OWN output
rather than choosing between its output and its artifacts; and the `useResultViewRunMeta` hazard
disappears rather than needing discipline, since a section inherits whatever step its host
window is already about.

The rules the surface itself holds to:

- **Six outcomes, one discriminant** (`binaryOutputView`): `not-started` (briefed, still queued) /
  `configured` (briefed and dispatched, nothing recorded yet — still running, or dead before
  settlement) / `undeclared` / `parse-failed` / `declared-none` / `stored`. Five are NOT "an empty
  list", and copy comes from ONE exhaustive `Record` so a seventh outcome fails the typecheck
  rather than rendering a missing key.
- **"Never briefed" is the section's ABSENCE**, and so is a SKIPPED step's. A step with neither a
  report nor a selection renders nothing at all, exactly as the effort section does — a row saying
  "no binary output was expected here" would ride every step of every run. A gated-out step takes
  the same absence: it holds a selection it never ran with, so no state describing a dispatch is
  true of it. A step not started YET is the neighbouring case and resolves the other way — it has
  a story ahead of it, and where the artifacts will land is worth stating in advance.
- **Every counted loss keeps its own line and its own number.** `invalidEntries` and `omitted`
  state their counts, and `omitted` says the list is a PREFIX.
- **The join is derived from the step's own record**, never a catalog read: a `stored` row whose
  service differs from `stepOptions.binaryOutput.storageServiceId` is marked, and the step's own
  target being unknown (`targetUnknown`) separates "the catalog changed under the run" from "the
  agent named a service that never existed". A step with NO selection has a null target and marks
  nothing misdirected — there was nowhere it was supposed to go.
- **The two unknown-service facts are DISJOINT FIELDS, not one list plus a flag.** The report's own
  `unknownServices` mixes the lost target with ids the agent invented, so a surface reading it raw
  either states the target twice or labels every unknown id as the step's own storage service and
  drops the invented ones. `targetUnknown` owns the first and `unknownDeclaredServices` (the same
  list, minus the target) owns the second, so naming either cannot mis-state the other — the
  exclusion belongs in the read model, where it is tested, not in a renderer's filter.

### The picker needed the trait on the wire

`BINARY_OUTPUT_TRAIT` never left the backend, so the builder had no way to know which steps must
offer a selection. It is projected onto the snapshot's custom-kind entry as
`CustomAgentKind.binaryOutput` — a BOOLEAN beside `container`, following the precedent that the
snapshot carries the facts the SPA branches on rather than the backend's trait vocabulary (every
other trait is prompt-shaping with no UI consequence; the day one gains one it gets its own
field). It is asked of the REGISTRY, not read off `def.traits`, so a trait ASSIGNED to an existing
kind projects like a declared one; `agents.ts` conformance pins both, plus the absence of the flag
on a kind without the trait.

`BinaryOutputStepPicker.vue` then offers the RESOLVED catalog — `asset-storage`-tagged for the
storage half (a requirement admission enforces), the whole catalog with `generation-context`-tagged
services ordered FIRST for the context half (that tag is conventional; admission enforces existence
only, so filtering on it would hide a choice the backend accepts). `binaryOutputPickIssues` mirrors
the admission refusals inline — its `unknown_service` / `not_storage_capable` members are kernel's
`BinaryOutputConfigIssue.problem` values verbatim — in translated copy, since the backend's own
prose is a "show details" detail rather than a description. Two frontend-only conditions sit beside
them, and keeping them apart is the point: an UNREACHABLE catalog is not an EMPTY one, and an
outage must not flag every selection for re-pick over something that changed nothing.

It stays in BOTH interface tiers. The variant picker beside it uses `showOverrideField` because
picking a variant OVERRIDES what the kind ships; this selection is REQUIRED, and hiding a required
input in basic mode leaves a step that cannot be saved with no way to find out why.

### What the generative half still owes these surfaces

Both surfaces were written against the storage-only shape and this change widens it, so each has a
counterpart here rather than a follow-up: the report's `unknownGenerators` and each stored row's
`generator` are rendered beside their storage twins (an integration id the deployment does not
register is the generative `unknownDeclaredServices`, and dropping it would re-open exactly the
silent-loss hole that field exists to close), and the picker offers `generatorIds` + `modalities`
with `binaryOutputPickIssues` mirroring `binary_output_generator_invalid` inline.

The picker's generative half needed one thing the other two did not: the integrations live in the
deployment's CODE, so there is no catalog read to filter. They ride the workspace snapshot as
`binaryGenerators` — the same route `CustomAgentKind.binaryOutput` takes, and for the same reason
(the snapshot carries the deployment-registered facts the SPA branches on). The projection is
IDENTITY ONLY — id, name, summary, modalities, mediaTypes — and deliberately omits the credential's
KEY NAME: the picker has no use for it, and a workspace viewer has no business learning which
environment variables the deployment sets.

## Remaining work

- [ ] **A worked example generator** in `backend/internal/example-custom-agent`, once a real
      image-generation harness path exists to demonstrate against.

When that lands, convert this tracker into a numbered ADR under `backend/docs/adr/` and `git rm`
it in the same PR.

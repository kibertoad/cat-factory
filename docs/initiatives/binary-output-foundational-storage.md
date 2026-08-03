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

## Remaining work

- [ ] **SPA pipeline-builder picker.** The REST/pipeline API carries `stepOptions.binaryOutput`;
      there is no Vue picker yet. It now has THREE halves to offer, and the generative one has a
      shape the other two don't: the integrations come from the deployment's code, so the picker
      needs a read for them (there is no catalog endpoint that returns them today) and it should
      offer the step's `modalities` beside the ids, since that is what makes the admission
      coverage refusal reachable from the builder rather than at start. It belongs beside the variant/skill step options, listing the
      workspace's resolved catalog filtered to `asset-storage`-tagged services for the storage
      half (and `generation-context`-tagged first for the context half). No longer blocked: the
      foundational-services management surface landed with
      [ADR 0031](../../backend/docs/adr/0031-foundational-services.md), so the resolved catalog
      the picker needs is already reachable from the SPA.
- [ ] **Step result view.** `PipelineStep.binaryOutputs` is recorded but no result window renders
      it; a small panel listing the stored artifacts (and the unknown-service / invalid-entry
      warnings) belongs in the `resultViews` slot.
- [ ] **A worked example generator** in `backend/internal/example-custom-agent`, once a real
      image-generation harness path exists to demonstrate against.

### Both SPA items are wanted as contributions, and the result view is the one to take first

Asked by a downstream deployment adopting ADR 0031, whose registered estate now has nothing
between it and a generator step but these two. The answer is yes to both, as upstream PRs rather
than a forked layer — they are additive slots by construction (a step-options component beside the
variant/skill pickers; one `resultViews` entry), which is exactly the shape the modular seams
exist to take from outside.

Take the **result view first**. The declaration parsing already keeps `unknownServices` /
`invalidEntries` / `omitted` apart precisely so a partial failure is legible, and today all of it
degrades loudly into a database column — so the view is not new behaviour, it is the missing half
of behaviour that already exists. Two rules bind it and are easy to miss:

- **Read the run's details through `useResultViewRunMeta(viewId, …)`**, never off `useResultView`'s
  `stepIndex`. A window opened OFF-PATH carries a block id and no step index, and that is the entry
  point people actually use — hand-deriving blanks the model, run id and token telemetry there.
- **"Absent" and "zero" must not render the same.** A step that stored nothing and a step whose
  declaration named a service the catalog does not know are different states with different fixes,
  and the second must name the id rather than showing an empty list.

For the **picker**, the constraint that is not obvious from the API shape: presence is refused
structurally at save AND at start, and resolution re-validates against the catalog at every
admission — so the picker filters the workspace's RESOLVED catalog (`asset-storage`-tagged for the
storage half) and must not offer an id from a stale client-side copy, or a step saves clean and
fails at admission. It is also a plain step OPTION, not an override of a default, so it stays in
both interface tiers rather than being hidden in `basic`.

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` it in the same PR.

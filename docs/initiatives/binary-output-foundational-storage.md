# Binary outputs stored through foundational services

**Goal.** Let a deployment run agent kinds whose deliverable is BINARY artifacts (image
generation is the canonical example) produced through generative integrations the deployment
registers in code (an image / music / video API such as Retro Diffusion), stored through a
foundational service the org already runs, and scoped by other foundational services that know the
domain (an entity inventory that can say what exists, what lacks an image, and how each thing is
described).

**Why this shape.** The platform's own binary-artifact store
(`BinaryArtifactStore`, the `binary-storage` TRAIT) holds run EVIDENCE: the UI Tester's
screenshots, read back by the visual-confirmation gate. A generated product asset is not evidence:
it belongs in the org's own storage, addressed the org's own way, found by the org's own systems.
The foundational-services catalog
([ADR 0031](../../backend/docs/adr/0031-foundational-services.md)) already models exactly that (a
registered shared capability with an API contract) so this feature is a third read off that
catalog, not a second storage subsystem.

## Model

- **A generator opts in by TRAIT, never a kind-id list**: `registerAgentKind({ traits:
['binary-output'] })` (`BINARY_OUTPUT_TRAIT`, `@cat-factory/agents`). No built-in kind carries
  it. The trait contributes the workflow guidance (consult scope first, store through the named
  service's contract, never commit binaries to the repo, declare what you stored).
- **The step selects the services and the INTEGRATIONS**: `stepOptions.binaryOutput`:
  - `storageServiceId`; the catalog service every artifact is stored through. Must carry the
    **`asset-storage` capability tag** (`ASSET_STORAGE_CAPABILITY`, kernel), because pushing
    product assets into the org's audit service is a configuration error, not a judgment call
    left to the agent. The tag is deliberately NOT spelled `binary-storage`: that is the agents
    package's `BINARY_STORAGE_TRAIT`, a marker on a KIND that needs the PLATFORM's artifact store
    for run EVIDENCE; the opposite claim about a different subject. While they shared one
    literal, `RunAdmission` imported both, a capability tag is a free-form string so a swap
    typechecked, and no behavioural test could tell. `binary-output-vocabulary.test.ts` in
    `@cat-factory/agents` (the only package that sees both vocabularies) pins them apart.
  - `contextServiceIds`: catalog services consulted for generation SCOPE. Existence is
    enforced; no tag is, since any service with a readable contract can inform scope. The
    conventional tag `generation-context` (`GENERATION_CONTEXT_CAPABILITY`) exists for pickers,
    not for enforcement.
  - `generatorIds`: the GENERATIVE INTEGRATIONS the step may call to produce the artifacts,
    from the deployment's code-registered `BinaryGeneratorRegistry` (see the section below).
    Absent ⇒ the step generates through whatever its agent already has, and the brief says so.
  - `modalities`: the CONTENT TYPES the step must deliver. Every one must be covered by a
    selected integration. It is deliberately not defaulted from the selection: "this step
    delivers audio" is a statement about the WORK, and deriving it would make removing the audio
    integration look like a change of requirements rather than a break.
- **Two refusal layers**, split exactly like the skill-step precedent (the generative half adds a
  third refusal under its own reason: see below):
  - PRESENCE is structural; `assertValidBinaryOutputSteps` in `validatePipelineShape`, so a
    generator step with no selection is a 422 at pipeline save AND run start.
  - RESOLUTION is admission: `RunAdmission.assertBinaryOutputSelected` re-validates the ids
    against the RESOLVED catalog at every start/retry/restart (the catalog can change after
    save), refusing 409 `binary_output_service_invalid` with `details.serviceId` /
    `details.problem` (`unknown_service` | `not_storage_capable`) / `details.role` as the
    headline, plus `details.issues`: EVERY unresolved id, not just the first. Surfacing one at a
    time would cost a refuse-fix-restart round per lost service; the message
    (`describeBinaryOutputConfigIssues`, kernel) names the whole fix.
- **The dispatch injects `.cat-context/binary-output/`** (`run-binary-output.ts`, a sibling of
  `run-foundational-services.ts` off the SAME resolver, so one tier merge and one cache):
  `brief.md` naming the storage + context services concretely, plus one contract file per
  resolved service (`renderContractDocument`, reused). The brief STATES every gap, no selection,
  an id the catalog lost since admission, a service with no registered contract, and the trait
  guidance names the brief's ABSENCE as "storage could not be provided: do not upload, report";
  so every failure degrades into a stated refusal rather than a guessed endpoint.
- **The declaration is the read-back**: the agent ends its reply with a fenced
  ` ```binary-outputs ` block: `none`, or a JSON array of
  `{ service, location, entity?, contentType?, description? }`. `parseBinaryOutputDeclaration`
  (kernel) parses it once, at step settlement (`job-facts.ts`, before every early-returning
  completion path), onto `PipelineStep.binaryOutputs`. The block is found by the shared
  `extractFencedDeclaration`, which takes the **LAST** match: the guidance says to END the reply
  with it, and a model that illustrates the shape first would otherwise have its example parsed
  and its answer discarded, reporting "stored nothing" about a run that stored things, which is
  worse than reporting nothing at all. The foundational-services parser reads through the same
  helper, so the rule holds for both. Bookkeeping is degrade-loudly throughout:
  `undeclared` (no block) ≠ empty `stored` (declared none) ≠ `parseFailed`; malformed entries are
  COUNTED (`invalidEntries`), over-cap entries are COUNTED (`omitted`), and a service id the
  catalog does not know is NAMED (`unknownServices`) while its entries are retained: the
  platform records the claim, a reader judges it against the configured target.

## Injection asks the effective kind; the read-back asks the step

The two halves cannot ask the same question, and the asymmetry is where records get lost.
Injection runs at DISPATCH and keys off the EFFECTIVE kind, which it is handed: a gate helper
or a PR-review override kind dispatches under its own kind, not `step.agentKind`. The read-back
runs on the durable completion path, which rebuilds everything from the STEP alone and therefore
cannot know which kind actually ran.

So `stepMayDeclareBinaryOutputs` is the UNION, both halves derivable from the step: its own kind
carries the trait, OR it carries a `binaryOutput` selection; the only thing a brief is ever
built from, so its presence means some dispatch here was briefed. Asking only
`hasTrait(step.agentKind)` silently drops the declaration of every trait-carrying kind dispatched
under an overriding kind: the artifacts exist, the step's record says nothing was stored, and
nothing errors. A step with neither was never briefed, so a block in its reply is a coincidence.

(The sibling foundational recorder still keys on `step.agentKind` alone. That is correct for it
today, no overriding kind carries `foundational-catalog`, but it is the same latent shape, so
it is worth revisiting if a deployment ever registers a design-capable gate helper.)

## The difference from the foundational-services reads

The catalog/contracts pair joins a DESIGN's declaration to its CONSUMERS: the architect chooses,
downstream kinds inherit. A binary-output step's join is its OWN step options: a human (or
pipeline author) selected the storage and scope services up front, so there is no declaration to
wait for and admission can validate the whole selection before anything dispatches.

## The generative half: registering the integrations

Storage answers where an artifact GOES. Nothing answered what MAKES it, so a deployment could
register a generator KIND and a place to put its output while the API that actually renders the
image stayed a thing the agent had to be told about in prose: with its key nowhere.

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
what a DESIGN is expected to consume (the Architect is shown all of it for exactly that purpose)
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
be two content types that look identical to a reader and silently never match: the failure
`reservedCapabilityNearMiss` exists to catch for the tags that must stay free-form.

The members are MODALITIES, not genres: music, speech and sound effects are all `audio`, because
what differs between them is the prompt while what differs between audio and video is the whole
integration. A deployment telling a music generator from a speech generator says so in
`mediaTypes` and the description. `mediaTypes` are validated against the declared modalities at
BOOT: a media type CONTRADICTING them is an error, an unrecognised one is not (the classifier is
not a registry of every format that exists).

#### Why 3D is two members and image is one

`3d-model` (one asset: a prop, a character, a part) and `3d-scene` (several assets composed, with
a hierarchy and typically transforms, materials, cameras or lights) are separate members, and the
asymmetry with `image` is the interesting part rather than an inconsistency.

Three axes describe a deliverable, and the rule is that each fact lives on the axis that can
actually carry it:

| Fact                        | Where it lives | Why                                                |
| --------------------------- | -------------- | -------------------------------------------------- |
| What KIND of thing this is  | `modalities`   | Decides which generator may serve the step         |
| What FORMAT it arrives in   | `mediaTypes`   | Providers differ; the consumer's importer is exact |
| What it depicts / its style | the prompt     | Nothing declares it and nothing could check it     |

A PNG and a JPEG are one modality with two formats, which is exactly what the second axis is for:
`image` does not split, because a step that must have a PNG says `mediaTypes: ['image/png']` and
admission checks it. A sprite and a background are one modality and one format, distinguished by
the prompt. **An asset and a scene are the one case where neither of the lower axes can help**:
they are the same modality by the old vocabulary AND the same format, because GLB, FBX, USDZ and
`.blend` each carry either one object or a whole scene graph. There is no media type for "a scene",
so a step that must deliver a level could be admitted against a prop generator with nothing
anywhere able to notice: the same failure the format check was added for, one level up. Splitting
the modality is the only axis left, which is precisely the bar a new member has to clear.

That is also why the classifier answers a LIST. `modalitiesOfMediaType` returns BOTH 3D members for
every 3D container, because that is the true statement about a `.glb`, and each consumer says what
it does with a multi-member answer: the boot check passes when the sets INTERSECT (requiring every
member would refuse a scene generator for declaring the only format it can emit), and a settled
artifact's classification declines entirely (`modalityOfMediaType` answers null unless the answer is
unambiguous); a guess about something that already exists is worse than an absence, and the step's
own declaration is the only thing that ever knew which of the two was being made.

### A step may also require exact FORMATS, and 3D is why

`stepOptions.binaryOutput.mediaTypes` sits one notch under `modalities`: the concrete containers a
step must deliver. It exists because the modality grain is exactly right for `image` and exactly
wrong for 3D. PNG versus WebP is a genre question that belongs in a prompt, but GLB, USDZ and FBX
are all one modality and none substitutes for another (a Godot importer takes the first, a
RealityKit pipeline the second, an art pipeline the third) so a step whose mesh must load in the
game could be admitted against an integration that cannot emit a loadable container, with the
failure arriving at the end of a paid run as an asset nobody can open. `video` and `document` sit
in between; `audio` genuinely does not need it.

This axis is also what BOUNDS the one above it. `3d-model` and `3d-scene` are two modalities
because no container tells them apart; `image` is one because a container tells PNG from JPEG. So a
distinction a format can carry is stated here, and only a distinction no format can carry earns a
modality member.

Four rules, each of which is the reason a plausible alternative was rejected:

- **Every entry is required, not any one of them.** A step delivering a GLB for the engine AND an
  FBX an artist can open in Blender declares both, and both are checked. An "any of these will do"
  reading was rejected because the agent is the party that names the container on the vendor call:
  a requirement that leaves it a choice hands that decision to the party with the least basis for
  making it. Declare the format you need, not the set you would accept.
- **A format is never translated into a modality.** `modalityOfMediaType` recognises only the
  formats the platform happens to know, so inferring one here would make the strength of a
  requirement depend on our vocabulary: a step spelled with a brand-new container would silently
  lose the coarse check its neighbour keeps. The two lists are independent statements and both are
  enforced as written.
- **Matching is EXACT, after ONE shared reduction.** Both declarations come through
  `mediaTypeSchema`; a settled artifact's `contentType` is the model's own prose and goes through
  `normalizeMediaType`: the same function, imported, never a second lowercasing. No synonyms are
  mapped: `model/obj` and `application/x-tgif` are the same file and stay different values, because
  a matcher that quietly accepted a near-neighbour would admit a GLB where an OBJ was required,
  which is the failure the requirement exists to prevent.
- **THREE outcomes, not two.** A generator declaring no `mediaTypes` has said "only my modality is
  known" (a documented state, not an empty answer) so a requirement it cannot be judged against
  is UNVERIFIABLE (`binaryFormatCoverage`), the run is admitted, and the gap is stated in the brief
  and the picker. Refusing there would punish the honest declaration; calling it covered would be
  the mirror mistake, a clean bill of health nobody issued on the surface that decides whether the
  run may start. It is the same disposition `generatorsUnverified` takes on the settlement side.
  With NOTHING selected there is nobody to be silent, so a format requirement is uncovered outright.

Asset-versus-scene is deliberately NOT one of these: the container carries no such distinction, so
it is a MODALITY (`3d-model` / `3d-scene`, above) and the format axis stays about the container
alone. What an artifact DEPICTS remains a prompt fact, observable at the grain the report already
records: separate assets arrive as separate entries with their own `entity`.

One thing sits outside the schema on purpose. **What an integration CONSUMES** stays in `guidance`: a chain between two registered integrations
(one's image feeding the other's image-to-3D path) is a fact about a PAIR, and the load-bearing
half of it (how the handoff travels, an inline body versus a URL the vendor fetches from its own
network) is exactly the part a modality-grained field could not carry. A structured field whose
only actionable use needs an unstructured one beside it reads as a machine-checkable capability the
platform never checks.

### Refusal, again in two layers, but against two different registries

`binaryGeneratorSelectionIssues` is checked at admission alongside the storage-side one, and
refuses under its OWN reason, `binary_output_generator_invalid`: `unknown_generator` (an id this
build does not register), `modality_uncovered` (a content type the step declares that nothing
selected produces) or `media_type_uncovered` (a format nothing that DECLARED its formats emits).
Keeping it apart from `binary_output_service_invalid` is not tidiness: a
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

1. the ENGINE resolves the selection onto `AgentRunContext.binaryGenerators`: ids, content types
   and the credential's KEY NAME, all non-secret, which is why the agent-context snapshot may
   record it;
2. the CONTAINER EXECUTOR resolves the values through the kernel `ToolSecretResolver` port (the
   facade's, so a deployment needing per-workspace keys implements the port and nothing else
   changes) and writes them to the job body's `generatorSecrets`;
3. the HARNESS layers them onto THAT JOB's agent env, never `process.env`, which the shared
   native host process makes a cross-job leak, and registers each value for redaction.

`ToolSecretResolver`'s input gained a discriminated `subject` (`tool-server` | `binary-generator`)
because two registries mint these ids and nothing stops them colliding: a deployment with a
`retro-diffusion` tool server AND a `retro-diffusion` integration would otherwise hand each the
other's secret from a per-workspace store.

**An unresolvable credential is not a failed dispatch.** The brief states, per integration, that
an unset variable means the platform could not provide the key and the integration must not be
called, and the agent can SEE the variable, so a second declaration from the executor could only
agree with the environment or contradict it. A run that generates what it can and NAMES the gap
beats one that refuses to start over the most ordinary misconfiguration there is.

### The brief leads with generation

`renderBinaryOutputBrief` is now three sections in the order the work happens: **Generation**
(each integration's content types, formats, endpoint, notes, credential variable and contract
file), **Scope**, **Storage**. What makes the artifacts is the decision an agent cannot recover
from later, and a generator that reads only the top of the file must still get it right. Every gap
is stated rather than omitted (an id the deployment no longer registers, a content type nothing
available produces, an integration with no contract) and the read-back records `generator` per
artifact with `unknownGenerators` kept apart from `unknownServices`, for the same
different-registry reason the refusals are.

## Runtime symmetry & mothership

Nothing new is persisted: the selection rides the pipeline/step JSON (`stepOptions`), the report
rides the step (`binaryOutputs`), and every read goes through the existing
`FoundationalServiceCatalogService` methods (already conformance-covered and already in the
`remote` RPC bucket) so both facades and mothership mode are correct by construction.

The generative half looked stronger still, and that reading was wrong. The registry is in-process
composition data with no repository behind it, so there is no method to route and nothing to
allow-list, but "a mothership-mode node reads the SAME definitions its own build carries" is only
true while both processes ship the same build, which is the exact assumption the foundational
`builtin` tier had already been fixed for. A local node one build behind is the NORMAL state of a
mothership deployment.

It is also the case CLAUDE.md's own rule names: **state a deployment registers in CODE and a RUN
resolves is org state**, and it rides its own `/internal/*` read rather than a second copy. This
registry shipped in violation of that rule, and a downstream deployment (stefka) hit it on its
first generative integration.

The symptom is louder than the estate's and worse targeted. The pipeline builder's picker is fed
from the WORKSPACE SNAPSHOT, which the mothership serves; run admission resolves the same ids on
the node. Register on the mothership alone and a human picks an integration from the product's own
picker, and every run of that step is refused with `unknown_generator`: a message that names the
step's configuration when the step's configuration is correct, leaving the half-wired deployment
invisible and the operator editing something with nothing wrong with it. Register on the node
alone and runs work while the step is unreachable through the builder. Registering on both is what
the shape forced, and nothing detected the skew.

So the set crosses the machine API, mirroring the estate file for file:

- **`BinaryGeneratorSource`** (`kernel/src/ports/binary-generators.ts`): `views()` +
  batched `documentsFor(ids)`, the two projections the registry already exposes, so a remote
  implementation is a transport and never a second view of the data.
- **`GET /internal/binary-generators`** + `POST .../contracts`, machine-token gated, no account
  scope (one deployment-wide set with no owner), reading this process's OWN registry so a
  satellite cannot answer for a satellite. Mounted on both facades; never 503s, because a
  deployment that registers none is legitimately empty.
- **`HttpBinaryGeneratorSource`**, which THROWS on every route to "we do not know the set":
  transport error, refusal, the 404 of a mothership older than the node, an unreadable 200.
- A mothership-mode node injects it as `binaryGeneratorSource` and does not consult its own
  registry for any run; `startLocal` warns at boot naming any locally registered ids it will
  ignore. The registry is still read for BOOT VALIDATION (the same code the mothership boots, and
  a laptop is the cheapest place to learn a definition is malformed) and to SERVE the route when
  this process is itself a mothership.

### The disposition, which is where this stops being a copy of the estate

The estate is ENRICHMENT: `resolveFoundationalContext` catches the throw and renders the outage
into the injected context file. The generative set is also an ADMISSION input, and there both
obvious dispositions are wrong. Softening to an empty set refuses every generator-selecting step
with `unknown_generator` for the duration of an outage: the misattribution above, now caused by
us. Admitting anyway dispatches a run with no brief and no credential, so the agent discovers at
the end of a paid run that it had nothing to generate with.

The answer is the third one: **fail admission with the outage's own code.** The `UnavailableError`
is re-thrown rather than re-mapped, so the caller gets a 503-shaped, retryable refusal carrying
`binary_generators_unreachable`, never `binary_output_generator_invalid`. It is the "absent ≠
zero" rule applied for the first time to a DECISION surface rather than an enrichment one.

The two BEST-EFFORT readers keep their own dispositions, and both are safe because each already
defines its own absence: the dispatch brief injects nothing, which the trait guidance already
reads as "the platform could not provide storage; do not attempt any upload; report it", and the
declaration read-back records what it CAN and says the rest was unverified.

That second one is worth stating precisely, because the obvious reading of "do not file an
unchecked id as invented" is to write no report at all, and that is wrong in the other
direction. A settled step's report is the evidence a human reads to decide whether the run's
artifacts are real, and the generative question is one line of it: the artifacts themselves and
the whole STORAGE verdict resolve against the workspace catalog, which an unreachable mothership
says nothing about. Dropping them would lose a completed generation's record over a question
nobody asked. So `BinaryOutputReport` carries `generatorsUnverified` as its own field, never an
empty `unknownGenerators`, which otherwise means "every claimed id checked out", and the SPA
renders it as its own warning line, counted by `binaryOutputHasWarnings` so a collapsed section
cannot present an unchecked report as a clean one. It is the same three-state split as the
picker's, at the other end of the run.

Nothing named a run start's REFUSAL, though, and the generic 503 copy the SPA falls back to says
"this deployment has not configured the capability this action needs", which is the exact
misattribution this whole feature removes, reappearing one layer up and in ten languages, with
the honest wording demoted to untranslated detail behind a disclosure. So user-reachable 503
reasons get their own translated copy, keyed off a `UNAVAILABLE_REASONS` union in
`@cat-factory/contracts` and an exhaustive `Record` in `usePipelineErrorToast`: the
`CONFLICT_REASONS` pattern, applied to the status class that needed it next.

### The picker is part of the fix, not a follow-up

Routing only admission and the dispatch would have moved the drift one surface along rather than
removing it: `snapshotBinaryGenerators` fed the picker from the container's own registry, so a
node that stopped double-registering would offer an empty picker while its runs resolved fine. The
snapshot projection therefore reads the SAME source, and carries `binaryGeneratorsUnavailable` for
the state a list cannot express: an empty picker is a claim about the deployment's BUILD, and
acting on it during an outage sends someone to the wrong repository. It never throws: a picker on
one step type must not take a board load down.

### Version floor

Closing this creates the same floor the estate's did: a node on the new `local-server` needs a
mothership new enough to answer the route, and an older one answers 404, which the client
reports as an outage rather than as an empty set, so the failure is legible rather than silent.

### What deliberately did NOT cross

The other four registry projections in the snapshot (`customAgentKinds`, `agentKindVariants`,
`customTaskTypes`, `initiativePresets`) stay per-process. An agent kind and an initiative preset
carry FUNCTIONS (`systemPrompt`, `userPrompt`, `detect`), so serializing one would mean inventing a
reduced wire form that is a second source of truth about what it DOES: the copy-drift this change
removes. `CustomTaskType` is, contrary to the proposal's claim that this was "the second and last"
transportable registry, pure data and could cross; it has not been asked to, and the trigger when
it is should be the same one as here (someone hitting the drift on a real deployment) not
symmetry for its own sake.

## How credentials reach the agent

For the STORAGE service, they still don't, through this feature. The contract tells the agent HOW
to call it; whether it CAN authenticate is the existing capability seams' job (a tool server with
a `ToolSecretResolver`-named secret, or test secrets), and a missing credential follows the
standing rule: stated to the agent, which reports the gap as a named omission instead of silently
dropping artifacts.

For a GENERATIVE INTEGRATION they do, and the section above says why the storage answer could not
be reused: the platform configures a tool server's client, while a generation API is called by the
agent's own code. If the storage half ever needs the same, it should ride the same three-step
channel rather than a second one.

### …but never the platform's OWN

That channel is the second path between the deployment's environment and an agent's process. The
first — a native-mode child inheriting `process.env` — has stated its invariant since it shipped
(`runtimes/local/src/childEnv.ts`: an allow-list projection, because a prompt-injectable subprocess
with shell access must not be handed `DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`). This
one had no equivalent, and it is the more exposed of the two, because the key name is chosen by a
DEFINITION rather than by the platform: `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer
<value>' }` was a registration that booted clean and shipped the master sealing key to whatever
endpoint the same definition named.

So a capability credential — a generative integration's and a tool server's alike — may not name a
variable the platform reads (`isReservedPlatformEnvKey`, `@cat-factory/contracts`). Four things
about the shape are load-bearing:

- **It is refused where the declaration is made AND at dispatch**, because a MOTHERSHIP-MODE node
  boot-validates none of the definitions it resolves — they arrive per dispatch over
  `/internal/binary-generators`, chosen by a process one build ahead of it, and the environment
  they name is a developer's own laptop. That is also the case that makes this a boundary problem
  rather than hygiene: `ENCRYPTION_KEY` and `HARNESS_SHARED_SECRET` are the keys to the split
  BETWEEN the two processes, held by the side that is meant to keep them, and nothing else about
  the mothership relationship reaches them (a prompt is in the transcript; a resolved key
  deliberately is not).
- **The dispatch-time check is at the CALL SITE, not inside `createEnvToolSecretResolver`**, so it
  binds a deployment's own per-workspace resolver too — the one that could genuinely hold a value
  under such a name — and an implementer of the port never has to know the rule exists.
- **The reserved set is the platform's WHOLE environment, not a hand-picked secret list**, matched
  case-insensitively (`process.env` lookup is case-insensitive on Windows, so a case-sensitive
  check would pass `encryption_key` and then resolve the real key). Over-reserving costs nothing —
  nobody names an integration credential `PORT` — while a per-variable judgement is wrong the
  moment a variable gains a sensitive use. The model-provider keys are reserved on purpose:
  `OPENAI_API_KEY` is billable and exfiltratable. Prefix FAMILIES carry the drift protection, and
  `scripts/check-reserved-env-keys.mjs` fails CI on a documented variable outside them.
- **The rule is NOT a mandated prefix on the credential's own side** (`GEN_…`, `TOOL_…`), which is
  the tidier positive rule and is unavailable here: a credential's `key` is also the ENVIRONMENT
  VARIABLE NAME the agent reads the value from, so mandating a prefix renames the variable inside
  the agent's process and breaks any SDK that auto-reads its vendor's documented name. The same
  positive rule applied to the side that already HAS a namespace — the platform's own families —
  costs nobody a rename.

An operator-stated bound on everything OUTSIDE that floor stays a deployment's call, because only
it knows which of a developer's own variables an integration may see. That is
`EnvToolSecretResolverOptions.allowKeys`, and it is now reachable: every facade takes a
`createToolSecretResolver` factory (`startLocal` / `start` / `createWorker`), defaulting to the env
resolver. Until it did, `ToolSecretResolver` was a port with exactly one reachable implementation —
the one each facade hard-coded — so the per-workspace credential store the port was designed for
meant abandoning the facade and reassembling the boot sequence, forgoing every preflight `start()`
exists to provide, to change one argument. A DERIVED bound (allow exactly the keys the registered
subjects declare) was considered and rejected: in mothership mode the registrations are the thing
the node does not control, so a bound derived from them is one the mothership chose, and on a
standalone node it is redundant with the definitions being code that node already runs.

### An integration declares what it PRODUCES, never what it consumes

`BinaryModality` is a DECISION vocabulary — the picklist is closed precisely because it decides
which generator may serve a step — and a descriptive `consumes: BinaryModality[]` would inherit
every migration that axis takes while deciding nothing. The `3d` split into `3d-model`/`3d-scene`
is the demonstration: every `consumes: ['3d']` would have become retired data needing a human to
re-pick a value whose only effect was printing a line in a brief.

It would not have removed the prose either. The fact worth stating about a pair of integrations is
never "this one accepts images" but "A's output can feed B's image path, and it must go inline as
base64 because B fetches `image_url` from its own network and the storage service is bearer-gated"
— a per-pair, per-transport fact that `consumes: ['image']` carries none of, so the paragraph in
`guidance` stays either way and the field becomes a fragment of it that can disagree with it.

**Chaining two integrations is a property of the WORK, and its home is the step's own prompt** —
which the platform owns and a human writes. Modelling it on a definition puts a fact about a pair
on one of its members, and the definition-level complaint underneath ("guidance attached to A does
not reach a step that selected only B") is that misfiling showing through. This is the general
rule, not a ruling about this one field: reach for the step's prompt before reaching for a
definition field whenever the fact is about a COMBINATION.

## The SPA surfaces

Both landed together. What each is, and the one design question the downstream proposal that
prompted them got wrong.

### The read surface is a shared SECTION, not a declared result view

`PipelineStep.binaryOutputs` is rendered by `BinaryOutputReport.vue`, resolved from the ACTIVE
STEP in two places: `ResultWindowShell`'s trailing sections (beside the effort and pre-PR
validation sections, so no result window can opt out of it) and `AgentStepDetail`, the generic
panel a step whose kind declares no result view opens instead; the shell is not involved there,
so both are needed and neither is a duplicate of the other.

**It is deliberately NOT a `presentation.resultView` a generator kind declares.** That was the
proposal's shape, and it cannot cover the record's own scope: `stepMayDeclareBinaryOutputs` is the
UNION (the step's kind carries the trait, OR the step carries a selection), precisely so a
trait-carrying kind dispatched under an OVERRIDING kind still has its artifacts recorded. A
kind-declared view is by construction blind to that case: the step's own kind declares some other
window, and the artifacts exist with nothing showing them. Three further things fall out of
resolving off the step instead: a deployment registers nothing (no id, no component, no
`RESULT_VIEW_IDS` entry); a generator stays free to declare a result view for its OWN output
rather than choosing between its output and its artifacts; and the `useResultViewRunMeta` hazard
disappears rather than needing discipline, since a section inherits whatever step its host
window is already about.

The rules the surface itself holds to:

- **Six outcomes, one discriminant** (`binaryOutputView`): `not-started` (briefed, still queued) /
  `configured` (briefed and dispatched, nothing recorded yet; still running, or dead before
  settlement) / `undeclared` / `parse-failed` / `declared-none` / `stored`. Five are NOT "an empty
  list", and copy comes from ONE exhaustive `Record` so a seventh outcome fails the typecheck
  rather than rendering a missing key.
- **"Never briefed" is the section's ABSENCE**, and so is a SKIPPED step's. A step with neither a
  report nor a selection renders nothing at all, exactly as the effort section does: a row saying
  "no binary output was expected here" would ride every step of every run. A gated-out step takes
  the same absence: it holds a selection it never ran with, so no state describing a dispatch is
  true of it. A step not started YET is the neighbouring case and resolves the other way: it has
  a story ahead of it, and where the artifacts will land is worth stating in advance.
- **Every counted loss keeps its own line and its own number.** `invalidEntries` and `omitted`
  state their counts, and `omitted` says the list is a PREFIX.
- **The join is derived from the step's own record**, never a catalog read: a `stored` row whose
  service differs from `stepOptions.binaryOutput.storageServiceId` is marked, and the step's own
  target being unknown (`targetUnknown`) separates "the catalog changed under the run" from "the
  agent named a service that never existed". A step with NO selection has a null target and marks
  nothing misdirected: there was nowhere it was supposed to go.
- **The two unknown-service facts are DISJOINT FIELDS, not one list plus a flag.** The report's own
  `unknownServices` mixes the lost target with ids the agent invented, so a surface reading it raw
  either states the target twice or labels every unknown id as the step's own storage service and
  drops the invented ones. `targetUnknown` owns the first and `unknownDeclaredServices` (the same
  list, minus the target) owns the second, so naming either cannot mis-state the other: the
  exclusion belongs in the read model, where it is tested, not in a renderer's filter.

### The picker needed the trait on the wire

`BINARY_OUTPUT_TRAIT` never left the backend, so the builder had no way to know which steps must
offer a selection. It is projected onto the snapshot's custom-kind entry as
`CustomAgentKind.binaryOutput`: a BOOLEAN beside `container`, following the precedent that the
snapshot carries the facts the SPA branches on rather than the backend's trait vocabulary (every
other trait is prompt-shaping with no UI consequence; the day one gains one it gets its own
field). It is asked of the REGISTRY, not read off `def.traits`, so a trait ASSIGNED to an existing
kind projects like a declared one; `agents.ts` conformance pins both, plus the absence of the flag
on a kind without the trait.

`BinaryOutputStepPicker.vue` then offers the RESOLVED catalog: `asset-storage`-tagged for the
storage half (a requirement admission enforces), the whole catalog with `generation-context`-tagged
services ordered FIRST for the context half (that tag is conventional; admission enforces existence
only, so filtering on it would hide a choice the backend accepts). `binaryOutputPickIssues` mirrors
the admission refusals inline (its `unknown_service` / `not_storage_capable` members are kernel's
`BinaryOutputConfigIssue.problem` values verbatim) in translated copy, since the backend's own
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

The FORMAT requirement reaches both surfaces too, and asymmetrically on purpose. In the picker it
is free TEXT, not a pick from the selection: the whole reason a step states a format is that the
selected integrations might not cover it, so a control offering only what they declare could never
express the requirement whose violation this feature exists to catch; what the selection declares
is offered as a hint beside it, and an entry that is not a `type/subtype` is named rather than
silently dropped. Its unverifiable line is styled apart from every refusal above it, because the
step starts. On the REPORT the surface makes the one judgement admission could not: admission
checked what the selected integrations CAN emit, and `undeliveredMediaTypes` checks what the run
came back with; derived in code from the step's own two records, never read off the agent's prose,
and computed only where there are artifacts to compare against (with none, the state line already
says nothing was recorded, and a second sentence would state one fact as if it were two).

The picker's generative half needed one thing the other two did not: the integrations live in the
deployment's CODE, so there is no catalog read to filter. They ride the workspace snapshot as
`binaryGenerators`: the same route `CustomAgentKind.binaryOutput` takes, and for the same reason
(the snapshot carries the deployment-registered facts the SPA branches on). The projection is
IDENTITY ONLY (id, name, summary, modalities, mediaTypes) and deliberately omits the credential's
KEY NAME: the picker has no use for it, and a workspace viewer has no business learning which
environment variables the deployment sets.

## Remaining work

- [ ] **A worked example generator** in `backend/internal/example-custom-agent`, once a real
      image-generation harness path exists to demonstrate against.

When that lands, convert this tracker into a numbered ADR under `backend/docs/adr/` and `git rm`
it in the same PR.

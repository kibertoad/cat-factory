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
  credentials: [{ key: 'RD_TOKEN', usage: 'the X-RD-Token request header' }],
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

### Two transports, because not every generator is an API

`transport` discriminates how an integration is REACHED: `api` (the default, and what every
definition above means) is a metered vendor endpoint the agent's own code calls with an injected
credential; `harness` is a tool built into the agent CLI the step dispatches under. Codex carries
one (`image_gen`, gpt-image-2), and it is available ONLY on ChatGPT subscription auth: an
`OPENAI_API_KEY` session is routed to the Images API and never offered the tool. So it is the one
generative path a deployment can offer with no vendor key anywhere.

A DISCRIMINATOR rather than "an integration with no endpoint", because those are different claims
and only one is checkable. An `api` definition missing its endpoint has said "nobody filled this
in"; a `harness` one has said "there is no endpoint, and here is what serves it". Left implicit,
the second reads as the first and the step is admitted to run under a CLI with no such tool.

Three consequences, each of which is a rule somewhere:

- **A harness transport may declare no `endpoint`, `credentials` or `contracts`** (schema check).
  The first two would only mislead the brief; the CREDENTIAL is the one that bites, because its
  value is injected into the agent's process, so declaring one means a variable the deployment
  believes authenticates something and that nothing ever reads. The auth is the leased
  subscription the run already used.
- **A harness transport may name only a CLI that actually GENERATES** (`harnessServesBinaryGeneration`,
  boot validation). "This build runs that CLI" and "that CLI has a generation tool" are two
  questions, and admitting the first lets a definition naming `pi` or `claude-code` pass every
  structural check, resolve, dispatch with the flag set, produce nothing, and brief the agent to
  collect from a staging directory nothing created. The run then reports a model problem for one
  string of deployment code.
- **Reachability is an admission axis of its own** (`generator_harness_unavailable`), because every
  other issue judges whether the integration can do the WORK and this judges whether it is in the
  process at all. The requirement is DERIVED from the step's resolved model
  (`RunAdmission.resolveStepHarnesses`), never declared. An unresolved model raises nothing: the
  third outcome the format, capability and value axes all take, because a guess about which CLI a
  step will run under is worse than an absence. It also SHORT-CIRCUITS the coverage axes, since an
  unreachable generator covers nothing and every one of them would restate the same fault.

  The derivation is a second copy of the dispatch precedence, and every way it can drift refuses a
  run that would have worked. Both halves bite: `resolveStepModelRef` falls THROUGH an unresolvable
  block pin rather than stopping at one, and `ModelRouter.resolveEffectiveRef` applies
  "subscriptions always win" ON TOP of a catalog flavour order that puts `subscription` LAST, so a
  dual-mode model on a workspace holding a token for its vendor dispatches on the subscription
  harness while the bare catalog order resolves it to a metered route. Miss either and the guard
  refuses a codex-served generator on a step that is about to run codex, or goes quiet on exactly
  the stale pin most likely to be wrong.

- **"Can generate images" is NOT a flag on the model catalog**, and that was the tempting shortcut.
  It is a property of the TOOL, which the vendor provisions per session and per plan tier and which
  demonstrably is not always offered (openai/codex#36832: the app exposes `image_gen` while the CLI
  filters it out on the same config). A boolean on a model row would be a guarantee nothing here
  can verify, persisted on blocks via `modelId`, going stale the moment the vendor changes gating.
  What the model legitimately contributes is WHICH CLI runs, which is exactly what the derivation
  above reads.

**Where the bytes land is the platform's problem, not the model's.** Codex writes to
`$CODEX_HOME/generated_images/` and exposes no path, URL or artifact id for it to the model
(openai/codex#28887, #28898, #28873, #28849, all open), and `codex exec --json` surfaces no
structured tool bodies at all — so asking the agent where it put the file is the thing that does
not work. `$CODEX_HOME` is also where the decrypted subscription credential lives, so sending the
agent to look there would point a prompt-injectable process at it. The harness therefore
REDIRECTS: `generated_images` is created as a symlink into `.cat-context/binary-output/generated/`
before the CLI starts, so the file is simply there when the tool returns, with no polling and no
race. A post-run sweep backs that up for a redirect that could not be made, and NAMES what it
found, because an image that arrived too late for the agent to store is a different fact from a run
that generated none.

**The tool is opt-in per job** (`generateImages` on the job body, set when the dispatch resolved a
harness-served generator). It bills the leased plan at 3-5x an ordinary turn, so an always-on image
capability would charge every run for one it never uses. The backend keys off the TRANSPORT and
never off a CLI name; which tool to enable is the harness's own business.

**And it is a handshake CAPABILITY** (`HARNESS_BODY_CAPABILITIES`), not merely an optional field.
The test that decides membership is whether the PROMPT would lie, and here it does: the generator
brief names the staging directory unconditionally, so a runner pool one image behind ignores the
flag while the agent is told where to collect from. That is the blind run the handshake exists to
refuse, and without membership the dispatch cannot even see the question.

**A capability that cannot be honoured is STATED, twice over.** Under `ambientAuth` there is no
per-run home to configure or redirect and the developer's own `~/.codex` is never touched, so the
tool is simply not there: `createCodexHome` answers the outcome rather than a bare home, and
`codexImageGapNote` folds one sentence into the prompt naming what is missing and pointing at the
brief's own "if the tool is unavailable, say so" instruction. A refused REDIRECT (an existing
directory, a filesystem that will not make a link) gets its own wording, because the tool is on and
its output is unreachable until the post-run sweep, which is a different fact and a different fix.
The teardown report reads the same outcome, so a rescued file is never called a late arrival when
the redirect never existed.

**The builder states the constraint it cannot check.** A pipeline is a template and the model is
resolved per block at dispatch, so the picker cannot judge whether a step will run the required CLI.
It says which CLI serves each harness-backed candidate (in the label) and which the current
selection therefore needs (`generator_harness_required`, ADVISORY), which is what keeps the
admission refusal from arriving as a surprise about a selection the product's own picker offered.

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

### The credentials: declared by name, delivered per job, never to a prompt

This is the one place the feature's original "credentials reach the agent through the existing
seams" answer did not hold. A tool server's credential works because the platform configures the
client; an image API is called by the agent's OWN code, so the value has to be in that job's
environment or the integration is decorative.

So a definition declares its credentials BY NAME and each value takes the same route a tool
server's does, one channel over:

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

**A vendor account is not always one string, so `credentials` is a LIST.** HTTP Basic over a
key/secret pair is the shape that breaks a single field, and it is common enough (Scenario,
Twilio, Mailgun and a long tail of REST APIs) to be a shape rather than one vendor's eccentricity.
The workaround under one field was colon-joining the halves into a single variable, which rotates
them together, offers the operator one checklist row where their vendor console shows two values,
and turns a mis-joined value into a 401 indistinguishable from a wrong key. Every other layer this
travels through was already plural (the resolver port takes `keys`, a tool server declares
`credentials`, the checklist keys rows by `(subject, id, key)`, the job body carries pairs), so
the single field was the one singular link in the chain.

Two rules come with it. INJECTION NAMES must be distinct within a definition, refused at
registration: the job body is keyed by the variable each value arrives as, so a collision does not
conflict loudly, one value silently wins and the integration authenticates with half a pair. And
the brief NAMES a multi-credential set before its parts, because two credential paragraphs read as
two independent keys and an agent has no reason not to try the first alone.

Distinctness is judged CASE-FOLDED, the same fold the reserved-key floor applies, because
`ACME_KEY` and `acme_key` are two declarations and one variable wherever the environment ignores
case. Comparing them exactly would call the pair distinct and let one value overwrite the other on
the one platform where nothing reports it. What is injected is still the spelling the deployment
wrote, which is also what the brief names, so the fold decides collisions and never what the agent
reads.

**The same name ACROSS definitions is refused only when the key behind it differs.** One vendor
behind an image endpoint and a music endpoint is one account, and sharing a variable is the point
there: both look the value up under the same key, so whichever resolves first sets it to exactly
what the other wanted. Different keys behind one name is the opposite and has no right answer.
Serving the first claimant sets the variable the SECOND integration's brief tells the agent to
read, so it authenticates one vendor with the other's key, and a pair loses a half the same way
while the brief still says the two names belong together. So boot refuses it
(`binary_generator_injection_name_collision`), and dispatch, which a mothership node reaches with
definitions it never boot-validated, withholds the value from every claimant rather than picking
one. Unset is the only state the brief already describes truthfully.

**The multi-credential set line states its joint rule over the REQUIRED members alone.** "Never
call the integration with a subset of them" is right for a Basic pair and contradicts an optional
member's own line, which tells the agent to call anyway when that one is missing. Below two
required members there is no subset to refuse, and the set line says so instead.

There is no `authScheme` field and deliberately so: the agent writes the request, `usage` is
already where each half says how it is presented, and a scheme enum would need a member for the
first vendor with a signed request or a rotating timestamp. The platform names values; it does not
assemble headers.

**The mothership relay refuses a reply carrying no `credentials`**, where the sibling capability
axis absorbs the same absence. The asymmetry is which state the fill would land on: an empty
capability declaration is a documented reading ("only the coarse facts are known"), while an empty
credential list reads as "this integration is unauthenticated" and the brief would tell the agent
so about a deployment that configured a key. That is a 401 reported against an integration nobody
gave credentials to, with the skew invisible. A node therefore needs a mothership new enough to
serve the plural field, and fails loudly against one that is not.

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
first (a native-mode child inheriting `process.env`) has stated its invariant since it shipped
(`runtimes/local/src/childEnv.ts`: an allow-list projection, because a prompt-injectable subprocess
with shell access must not be handed `DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`). This
one had no equivalent, and it is the more exposed of the two, because the key name is chosen by a
DEFINITION rather than by the platform: `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer
<value>' }` was a registration that booted clean and shipped the master sealing key to whatever
endpoint the same definition named.

So a capability credential, a generative integration's and a tool server's alike, may not be LOOKED
UP BY a variable the platform reads (`isReservedPlatformEnvKey`, `@cat-factory/contracts`). Five
things about the shape are load-bearing:

- **It is refused where the declaration is made AND at dispatch**, because a MOTHERSHIP-MODE node
  boot-validates none of the definitions it resolves: they arrive per dispatch over
  `/internal/binary-generators`, chosen by a process one build ahead of it, and the environment
  they name is a developer's own laptop. That is also the case that makes this a boundary problem
  rather than hygiene: `ENCRYPTION_KEY` and `HARNESS_SHARED_SECRET` are the keys to the split
  BETWEEN the two processes, held by the side that is meant to keep them, and nothing else about
  the mothership relationship reaches them (a prompt is in the transcript; a resolved key
  deliberately is not).
- **The dispatch-time check is at the CALL SITE, not inside `createEnvToolSecretResolver`**, so it
  binds a deployment's own per-workspace resolver too, the one that could genuinely hold a value
  under such a name, and an implementer of the port never has to know the rule exists.
- **The reserved set is the platform's WHOLE environment, not a hand-picked secret list**, matched
  case-insensitively (`process.env` lookup is case-insensitive on Windows, so a case-sensitive
  check would pass `encryption_key` and then resolve the real key). Over-reserving costs nothing,
  since nobody names an integration credential `PORT`, while a per-variable judgement is wrong the
  moment a variable gains a sensitive use. The model-provider keys are reserved on purpose:
  `OPENAI_API_KEY` is billable and exfiltratable. Prefix FAMILIES carry the drift protection, and
  `scripts/check-reserved-env-keys.mjs` fails CI on a documented variable outside them.
- **The rule is NOT a mandated prefix on the credential's own side** (`GEN_…`, `TOOL_…`), which is
  the tidier positive rule and is unavailable here: a credential's `key` is also the ENVIRONMENT
  VARIABLE NAME the agent reads the value from, so mandating a prefix renames the variable inside
  the agent's process and breaks any SDK that auto-reads its vendor's documented name. The same
  positive rule applied to the side that already HAS a namespace (the platform's own families)
  costs nobody a rename.
- **A credential therefore has TWO names, and the floor binds only the LOOKUP one.** The same
  argument that rules out a mandated prefix rules out holding the INJECTION name to the reserved
  list: the families cover `GITHUB_PERSONAL_ACCESS_TOKEN`, `SLACK_BOT_TOKEN` and
  `AWS_ACCESS_KEY_ID`, which the platform does not read and a vendor's own SDK does. With one name
  for both jobs the floor would make the commonest MCP servers unusable, with no workaround open to
  a deployment. So `envName` carries the injection name, held to the narrower `isToolchainEnvName`
  rule instead, since it reads nothing. An `http` tool server always had this split (`key` is the
  lookup, `header` is where the value goes); `envName` is that split for the stdio and generative
  cases.

An operator-stated bound on everything OUTSIDE that floor stays a deployment's call, because only
it knows which of a developer's own variables an integration may see. That is
`EnvToolSecretResolverOptions.allowKeys`, and it is now reachable: every facade takes a
`createToolSecretResolver` factory (`startLocal` / `start` / `createWorker`), defaulting to the env
resolver. Until it did, `ToolSecretResolver` was a port with exactly one reachable implementation,
the one each facade hard-coded, so the per-workspace credential store the port was designed for
meant abandoning the facade and reassembling the boot sequence, forgoing every preflight `start()`
exists to provide, to change one argument. A DERIVED bound (allow exactly the keys the registered
subjects declare) was considered and rejected: in mothership mode the registrations are the thing
the node does not control, so a bound derived from them is one the mothership chose, and on a
standalone node it is redundant with the definitions being code that node already runs.

### An integration declares what it PRODUCES, never what it consumes

`BinaryModality` is a DECISION vocabulary (the picklist is closed precisely because it decides
which generator may serve a step) and a descriptive `consumes: BinaryModality[]` would inherit
every migration that axis takes while deciding nothing. The `3d` split into `3d-model`/`3d-scene`
is the demonstration: every `consumes: ['3d']` would have become retired data needing a human to
re-pick a value whose only effect was printing a line in a brief.

It would not have removed the prose either. The fact worth stating about a pair of integrations is
never "this one accepts images" but "A's output can feed B's image path, and it must go inline as
base64 because B fetches `image_url` from its own network and the storage service is bearer-gated"
which is a per-pair, per-transport fact that `consumes: ['image']` carries none of, so the paragraph in
`guidance` stays either way and the field becomes a fragment of it that can disagree with it.

**Chaining two integrations is a property of the WORK, and its home is the step's own prompt**,
which the platform owns and a human writes. Modelling it on a definition puts a fact about a pair
on one of its members, and the definition-level complaint underneath ("guidance attached to A does
not reach a step that selected only B") is that misfiling showing through. This is the general
rule, not a ruling about this one field: reach for the step's prompt before reaching for a
definition field whenever the fact is about a COMBINATION.

### …and nothing about the CHOICE between two producers of one content type

The rule above generalises, and the generalisation was asked for by the deployment that first
registered two image APIs on one registry. A modality DECIDES which generator may serve a step, and
it stops deciding at the second producer of one kind: a step declaring `modalities: ['image']` is
admitted holding either, both selections are correct as far as `binaryGeneratorSelectionIssues` can
see, and exactly one is right for any given step. Asking a general image API for a 32px inventory
icon does not fail. It succeeds, it charges, and it returns a smooth render shrunk to 32px, on a
file whose modality, format and storage verdict all check out.

**A discriminator on the definition (a `style`, a `resolutionRange`, an `intendedUse`) is refused,
on three grounds.** The first two are the `consumes` argument one level up: an axis on which two
producers of one modality can differ has no natural end (resolution, pixel grid, realism,
animation, tileability, character consistency, licence terms), and each member added is a migration
for every definition that exists; and the fact it would encode ("sprites come from the pixel-art
API, key art comes from the general one") is a sentence about one project's art pipeline, false for
a project that renders sprites at 4 MP and downsamples, so putting it on a vendor definition files
a fact about a decision under one of the things being decided between.

The third is the one that is specific to this axis and is why it is refused rather than merely
discouraged: **`modalities` and `mediaTypes` can carry an admission rule because each PARTITIONS the
deliverable.** A file is an image or it is not; it is a GLB or it is not; so `covered` / `uncovered`
is computable and a refusal is a fact. Style does not partition anything. A stylised 128px portrait
is genuinely both things, so there is no predicate to compute, and a field with a rule and no
predicate does not fail to help: it REFUSES correctly-configured steps, adjudicated by a picklist
neither definition's author was thinking about. `consumes` was harmless-but-useless; this would be
harmful.

**What discriminates instead, in order.** `generatorIds` is the real discriminator and it is the
step author's: a step that should only ever use the pixel-art API selects only that one, and none
of this arises. `binaryOutput.mediaTypes` discriminates where the vendors differ, which is the
second job that field turned out to do: a step needing an animated sprite (`image/gif`) or a
photographic JPEG can say so and be refused for holding the wrong integration, and it bites exactly
when the format IS the requirement. The residual case is the step that legitimately holds both and
needs a PNG from one of them, where the choice is about the KIND of picture, and there the step's
own prompt is the only thing that can carry it.

**The platform's contribution is to make the choice VISIBLE, and to compute nothing else.**
`binaryModalityOverlaps` reports which content types more than one selected integration produces.
Four rules bind what is done with it:

- **It states the fact and RANKS NOTHING.** "Prefer the narrower modality set" and "prefer the one
  declaring the format exclusively" were both tried and both are right by accident: narrowness is
  not correctness (a specialist pixel-art API and a specialist photo API are equally narrow and
  answer different questions), and the platform has no cost model, no quality model and no view of
  what the step is for. A confident wrong preference is worse than none, because it displaces the
  per-integration descriptions the reader would otherwise have gone to.
- **It refuses nothing.** No new `BinaryGeneratorSelectionIssue`. Holding two image integrations is
  not a misconfiguration; it is the case that motivates a selection being a list.
- **It is computed from the SELECTION, never the registry and never the step's requirements.** A
  step is unaffected by integrations it did not select, so the registry would over-report; and the
  step that most needs the paragraph is routinely the one where neither shared content type is the
  deliverable (concept art generated to feed a mesh API's image path, on a step declaring
  `3d-model`), so gating on `modalities` would go silent on exactly it.
- **A registration-time diagnostic was considered and is refused.** Overlap is what a mature
  registry looks like: any deployment with a cheap vendor and a good one, or an incumbent and its
  replacement mid-migration, has it permanently and correctly. Boot validation exists to fail a
  deployment on things that are WRONG, and a warning firing forever on a correct configuration is
  one operators learn to scroll past. It would also fire at the wrong party, since the only action
  available at registration is to unregister something, which is precisely the wrong lesson.

It lands on **both** surfaces, from that one function, because they inform different parties at
different moments. Each names the shared CONTENT TYPE and every ID that produces it: "some of these
overlap" is a puzzle, and both values are already on the view, so the whole value is in being
specific. The brief (`renderBinaryGeneratorSection`) states it to the AGENT, after the
per-integration entries so that "read each one's notes above" is literally true, and silently when
there is no overlap, because a paragraph riding every brief is one agents stop reading. The picker
conveyed it nowhere before this: each candidate is labelled with what it produces, but a human
reading two identical labels is being shown the overlap rather than told about it, which is the
same absence-reads-as-fine failure the rest of that surface exists to avoid. It now states it
advisory-styled beside `media_type_unverifiable` rather than among the refusals, because that is
the party who both knows why two were selected and has the step's prompt open to write it down. The
brief catches the step whose author did not think to write it; the picker catches the author.

**Two readers is what decides where the rule LIVES**, and it settles a question this feature had
already answered the other way once. `binaryModalityOverlaps` sits in `@cat-factory/contracts`
beside the vocabulary it reads, so both sides import the same implementation; and
`binaryFormatCoverage` moved there with it, having shipped in kernel with a hand-written copy in
`app/utils/binaryOutput.ts` for a reason that did not survive being written down ("the rule needs
kernel's view type"): it needs `{ mediaTypes }`, which is what the SPA's copy was proving all
along. The test is not which package the rule feels like it belongs to but **who has to agree
about the answer**. A rule the builder states to a human and the brief states to an agent is one
where a divergence shows up as two descriptions of one selection, days apart, with nothing
comparing them, so it belongs in the package both can import even when its most natural home
would be kernel. What stays kernel-side is everything that needs kernel's own types: the registry
views, the resolution of a step's ids against them, and the DISPOSITION of each outcome (which
refuses the run, which only warns), which is a fact about admission rather than about the
selection.

The brief's paragraph also asks for the declaration block's `generator` field, which is otherwise
optional. Optional is right in general (most steps hold one producer per content type, so the
answer is not in doubt), and the moment two are held it is the ONLY record of a choice nothing
downstream can check. `BinaryOutputReport.vue` already renders it per row, so the loop closes: the
brief makes the agent notice it is deciding, and the report shows afterwards what it decided.

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

## Capability traits: what an integration can be ASKED FOR

`modalities` and `mediaTypes` say what an integration MAKES. Neither says what it will accept
while making it, and the four image APIs a deployment is most likely to register agree on almost
none of that: Flux Kontext edits from an instruction and Flux Fill takes a mask, Nano Banana fuses
several reference images and exposes no seed, Grok Imagine returns `n` candidates from one call
and takes no aspect ratio, Retro Diffusion takes a negative prompt, a seed, tiling, background
removal and an upscale factor. A step that hands a reference image to an endpoint with no image
input does not produce a worse picture. It errors at the end of a paid run, or it succeeds having
silently ignored the one input that made the output correct, which is worse because every
downstream check passes.

So a definition declares `capabilities` (`binary-capabilities.ts`, `@cat-factory/contracts`), a
closed vocabulary, and a step declares `binaryOutput.generation`: reference images with a ROLE,
an edit (instruction or masked), a negative prompt, a seed, an aspect ratio, an upscale factor,
a transparent background, seamless tiling.

**Why this is not the discriminator the section above refuses.** `style` / `resolutionRange` /
`intendedUse` were refused on three grounds, and the third is the one that decides: `modalities`
and `mediaTypes` can carry an admission rule because each PARTITIONS the deliverable, while style
does not, so a rule built on it refuses correct steps by the taste of whoever wrote the picklist.
A capability partitions exactly: an endpoint either accepts an input image or it does not, either
takes a mask or it does not, and the answer is a fact about the API rather than an opinion about
the art. It also decides nothing about WHICH of two producers to call, which is the job the
design record left with `generatorIds`, the format requirement and the step's own prompt. A
capability that told two producers apart without unlocking an option would be the refused
discriminator wearing a new name, which is why the membership bar is **the platform exposes
something because of it**: a control the builder shows, a paragraph the brief writes, a
requirement admission refuses. Everything else stays prose in `description` / `guidance`.

Five rules bind it:

- **The requirement is DERIVED, never declared.** `requiredBinaryCapabilities` reads what the step
  actually asks for, so one reference image needs `reference-image` and not `multi-reference`, and
  an edit needs exactly the capability its mode names. A declared requirement would let a step be
  refused over an option it does not exercise.
- **THREE outcomes, the same three the format check has.** `binaryCapabilityCoverage` is
  `binaryFormatCoverage` one axis over: a definition declaring no capabilities has said "only the
  coarse facts are known", so a requirement against it is UNVERIFIABLE rather than uncovered. That
  is what lets this ship without retroactively invalidating every integration registered before
  the axis existed, and it is why the picker still OFFERS a control against an undeclared
  selection (hiding one would be a claim about a vendor's API that nobody established).
- **Coverage is not the whole answer once two producers are held.** `binaryCapabilityProviders`
  names which of them honour each option, because an aspect ratio honoured by one and ignored by
  the other leaves nothing on the artifact to say which happened.
- **The brief speaks the platform's vocabulary, never a vendor's.** The agent writes the request
  and only it knows what the endpoint in front of it calls a seed. It also NAMES every reference,
  source and mask as a location the agent must fetch itself, because the platform never fetches
  them and an agent not told where a file lives generates without it and reports success.
- **`candidate-batch` unlocks no control**, and is the one member that earns its place by changing
  an INSTRUCTION: ask a batching API for `n` in one call, repeat the call with a different seed
  otherwise. Getting that backwards either multiplies the bill or sends a parameter the endpoint
  rejects.

A per-vendor knob nobody else has (`prompt_upsampling`, `safety_tolerance`, a sampler name) stays
in that integration's `guidance`, where a sentence can say what it means, rather than becoming a
field every other integration ignores.

### The size axis, and why one member could not carry it

`aspect-ratio` shipped meaning "an explicit aspect ratio OR output size", and that disjunction was
the bug. The four image APIs a deployment is likely to register split cleanly in two: Flux and Retro
Diffusion take a width and a height, Nano Banana takes one of four `image_size` buckets and Grok
Imagine a `resolution` of `1k` or `2k`. Under one member all four declare the same thing, so a step
whose deliverable is a 96x96 inventory icon is admitted holding only the bucketed one. It then
generates a 1K image and downsamples, which on a small sprite is not a worse render of the same
asset, and nothing reports it: the modality is covered, the format is covered, the upload succeeded,
and the deliverable is wrong in the one dimension the inventory actually specified.

So `exact-size` is its own member, unlocking `generation.outputSize` (`{ width, height }`). It clears
the membership bar the section above sets, on the ground that DECIDES: an endpoint either accepts
pixel dimensions or it does not, which is a fact about the request shape rather than an opinion about
the art, so `covered` / `uncovered` is computable and a refusal is a fact. That is the same property
that got `mediaTypes` its admission rule and that `style` / `resolutionRange` / `intendedUse` could
not supply.

Four rulings bound it, and each is the reason a nearby version was refused:

- **The vocabulary stays FLAT: `exact-size` does not IMPLY `aspect-ratio`.** An API taking width and
  height honours any ratio, so it declares both, exactly as a multi-reference API declares
  `reference-image` beside `multi-reference`. An implication table is an ordering over a picklist
  that every future member then has to be placed in, bought to save a deployment one word in its own
  registration, and the cost of forgetting that word is a refusal that NAMES the missing capability.
- **The platform states no per-integration size table.** Flux caps at 4 MP and wants multiples of 32;
  Retro Diffusion's range moves with the style. A table of that is the refused `resolutionRange`
  wearing a new name, and it would go stale in this repo while the vendor changed it in theirs. This
  axis answers only "can it be handed dimensions at all"; the limits stay in `guidance`.
- **A size is stated ONCE.** `outputSize` is mutually exclusive with `aspectRatio` and `upscale`,
  refused structurally at save (`assertUnambiguousOutputSize`), because each of those states the
  delivered dimensions a second time and can disagree. Resolving it by precedence instead would hand
  the leftover decision to the agent writing the vendor call, which is the same party the
  every-format-required rule keeps it away from. WHICH options conflict is contracts'
  `conflictingOutputSizeOptions`, not a rule stated twice: the builder offers all three controls
  together, so it has to raise the same refusal (`output_size_ambiguous`) where the fix is deleting
  one of two visible fields, and a rule with a home on only one side is one the two sides drift on.
- **No resize POLICY, at any layer.** The platform has no view of whether a downscale is acceptable
  for a given asset, so the brief states the target and requires that a substitution be REPORTED and
  the delivered size declared. What it never says is what to do instead, and it makes no claim about
  what the CONSUMER of the artifacts does with a substituted one: that is a fact about a game, a
  storefront or a print run, none of which the platform can see.
- **A size covers what is MEASURED in pixels**, which is contracts' `modalityCarriesPixelDimensions`
  (`image` and `video`; not audio, 3D or documents). A step generating an icon and its pickup sound
  states one size and means it about the icon, so the brief scopes it and the report judges only the
  covered artifacts. An artifact the platform could not CLASSIFY stays covered: absent is not "not an
  image", and excluding it would turn an unreadable content type into a silent pass on the one axis
  the requirement exists to check.

**The read-back closes it, and admission alone would not have.** The capability gate checks what a
selected integration can be ASKED for; the complaint that motivated the axis is a DELIVERY fact. So a
declared artifact carries optional `dimensions`, and `BinaryOutputView` derives `missized` against
the step's own `outputSize` (and renders the reported dimensions on the row beside it, so a counted
failure names which artifact), the same judgement `undeliveredMediaTypes` makes one axis over and from
the same kind of self-report (the platform never holds the bytes; `contentType` has always been the
agent's own claim on the same terms). `sizeUnreported` counts the unmeasured artifacts SEPARATELY,
because an artifact that stated no dimensions and one that came back wrong are the same value and
opposite facts. A malformed `dimensions` drops the measurement and KEEPS the entry: the identity
fields are what make a record findable, and losing a stored artifact over an optional observation
would be the reporting loss this feature exists to prevent.

### The value axis: a capability is a yes/no, and some endpoints answer "yes, at one of these"

A capability partitions "can the request carry this at all", and for several real endpoints that
is only half the truth. Grok Imagine and Nano Banana take an aspect ratio from a closed picklist;
Flux and Retro Diffusion honour any ratio because they take a width and a height. All four declare
`aspect-ratio`, so a step asking for `7:3` is admitted against every one of them and served by
two. Nothing reports the crop: the modality is covered, the format is covered, the upload
succeeded. That is the silent wrong artifact the capability axis exists to prevent, arriving
through the capability axis, and no wording of a yes/no repairs it.

So a definition may also declare `accepts` (`binary-capabilities.ts`): the closed SETS of values
it takes, per option, for the three options with an enumerable domain (`aspectRatios`,
`outputSizes`, `upscaleFactors`). `binaryValueCoverage` judges the step's requested value against
them, admission refuses `option_value_unaccepted`, and the picker and the brief state the rest.

**Why this is not the per-integration table the design record refuses.** It clears the same bar
`mediaTypes` cleared: a set of accepted values partitions exactly, so `covered` / `uncovered` is
computable and a refusal is a fact rather than a taste. It also unlocks nothing new to ASK for,
which is the property that separates it from `style` / `resolutionRange`: it makes an existing ask
checkable. And staleness cuts the safe way, which is the objection worth answering directly. A
vendor that ADDS a value leaves the declaration too narrow, and a step asking for the new one is
refused by name: visible, and one word to fix. A vendor that REMOVES one leaves it too wide, which
is exactly today's behaviour and no worse. The status quo, by contrast, fails silently and
delivers the wrong asset.

Five rulings bound it:

- **FIVE outcomes, and the extra silent one is what let this ship.** Judged per option and PER
  DECLARER over the integrations that DECLARE the gating capability (counting the others would
  report one fault twice under two headings): nobody stated a set is SILENT, every stated set
  containing the value is covered, some stated set containing it beside one that EXCLUDES it is
  PARTIAL (advisory, naming who excludes it), no stated set containing it with some declarer
  silent is UNVERIFIABLE (advisory), and every declarer having enumerated it away is UNACCEPTED
  (refusal). The silent case is the one that matters most: it is the state every registration is
  in until an endpoint is audited, and an advisory that fired there would ride nearly every step
  carrying an aspect ratio, which is how a line stops being read.
- **The disposition is a function of the WHOLE declarer set, never of the first agreeable member.**
  Shipped as a `some(accepts)` short-circuit, the rule went silent on its own motivating example
  the moment BOTH endpoints enumerated: one takes `7:3`, the other crops to its nearest listed
  shape, no refusal and no advisory, with `binaryCapabilityProviders` naming both as honouring the
  option one paragraph earlier in the same brief. It also inverted the reporting, which is the
  sharper tell: the LESS informed selection (a declarer that stated nothing) raised an advisory, so
  auditing that endpoint and writing down an accurate set BOUGHT SILENCE. Partial is advisory
  rather than a refusal for the reason one declarer covers a capability: which integration renders
  which artifact is the agent's call. What is not optional is NAMING the ones that refuse, since
  routing around them is the entire remedy.
- **A stated `accepts` set whose gating capability is undeclared fails BOOT**
  (`binary_generator_accepts_without_capability`), the same class as the media-type/modality
  contradiction beside it. Left to run, the two halves are believed by different readers: the brief
  renders the set as fact, the value rule judges only over the capability's declarers and never
  sees it, and admission refuses every step asking for the option as `capability_unsupported`. The
  accurate half is unreachable and the step is refused for lacking a capability the same
  registration was documenting.
- **An endpoint that takes NO parameter declares nothing, and a set cannot rescue it.** Recraft's
  `crispUpscale` enlarges at a ratio it fixes itself, so declaring `upscale` for it would admit a
  step asking for 4x and hand back an unknown multiple. `upscale: [2]` would not be a narrower
  statement of that truth, it would be a fabricated one. The line is whether the REQUEST can carry
  the value, and an endpoint on the wrong side of it says what it does in `guidance` and is
  refused the option: a visible false refusal beats a silent wrong artifact, and the honest
  reading is usually that the option was the wrong way to state the requirement.
- **A set, or nothing. No ranges, and no negotiation.** `min`/`max`/`step`/`multiple-of` is a
  constraint language, and the first thing it would have to express is Flux's "any pair up to 4 MP
  in multiples of 32", which is the `resolutionRange` discriminator wearing a new name. An
  endpoint with a genuine range declares the capability, states no set, and puts its limits in
  `guidance`. A "closest supported value" rule is refused for the opposite reason: it turns the
  refusal back into the silent substitution this whole axis is about. An empty list is refused at
  registration too, so absent stays the one spelling of "not stated".
- **`exact-size` moved, and the move is the structural half of this change.** It used to mean
  ARBITRARY dimensions, which forced an endpoint whose `size` parameter offers a closed list of
  `WxH` values to declare `aspect-ratio` instead: a size-taking API classified as shape-taking,
  with a step needing 96x96 admitted against one whose nearest listed value is 1024x1024. Now the
  capability answers what the REQUEST CARRIES (a shape goes on `aspect-ratio`, dimensions on
  `exact-size`, both when both) and `accepts.outputSizes` answers which ones. Capabilities are
  declared in deployment code and never persisted, so nothing had to migrate; a definition that
  declared `aspect-ratio` for its size list keeps working and gains a better option.

The sibling this deliberately does NOT add is a MAXIMUM: Flux takes eight reference images and
Grok Imagine takes three, both declare `multi-reference`, and a step handing over five is admitted
and quietly served with three. It is the same family of fault and it needs a different predicate
(a bound, not a membership) and a different refusal payload, and the option it constrains is a
list the step authors rather than a value it picks. Recorded in the remaining work below rather
than folded in here, so it is not rediscovered from scratch.

## Side-by-side candidates: the choice the platform CAN make visible

The section above states the overlap and ranks nothing, on the ground that the platform has no
cost model, no quality model and no view of what the step is for. That is right while the choice
has to be made BEFORE the pictures exist. It is the wrong answer when it does not have to be: two
image APIs asked for the same sprite return two sprites, and a person decides in a second what no
description could have decided in advance.

So `binaryOutput.comparison` turns a generating step into TWO dispatches of one step with a human
park between them, exactly the shape [ADR 0022](../../backend/docs/adr/0022-coder-fork-decision.md)
established for the fork decision (a container job cannot pause mid-run). Phase A generates a
candidate per subject from every selected integration, stages them through the step's OWN storage
service, and declares them in a fenced ` ```binary-candidates ` block; the run parks; phase B
re-runs the same step with the kept candidates folded into its brief.

- **The platform never holds the bytes**, which is the rule the whole feature runs on. What the
  SPA renders is whatever preview URL the storage service issued, admitted `https`-only because it
  is model-authored text going into an `<img src>` on the board (deliberately not
  `isAllowedMcpHttpUrl`, whose own note says it is not a guard for untrusted input). A service
  that issues no link leaves the candidate legible as metadata and SAYS the preview is
  unavailable, which is what lets a private estate use the feature at all; a refused link costs
  the candidate its picture, never its row.
- **The decision is DATA and the agent executes it.** Keeping a candidate moves no file: it
  records which survive and under which id, and phase B promotes exactly those and clears the
  rest. The platform's own artifact store is for run evidence, and a product asset it never
  touched is not something it should start touching to implement a picker.
- **ALTERNATE IDS are what make keeping two a real outcome.** Two survivors at one address is one
  artifact, so `storeAs` is required per kept candidate above one, refused at the write boundary
  (duplicate ids, and a second survivor with no id at all) rather than left to an agent that
  cannot tell a deliberate overwrite from a collision.
- **Three dispositions, and only one of them parks.** Two or more candidates park. Exactly ONE is
  kept automatically, with `choice.automatic` set so no surface can present an unreviewed artifact
  as a reviewed one: the fork decision's `single_path` escape hatch, one subject over. NONE falls
  through to the ordinary completion with a `noChoiceReason` (`undeclared` / `parse_failed` /
  `no_candidates`) on the step, because a comparison that wedged a run over a forgotten fenced
  block would be a worse failure than the one it exists to prevent.
- **A comparison that cannot compare is refused at SAVE.** One integration and `perGenerator: 1`
  yields one candidate per subject, which is auto-kept, so the review someone configured silently
  never happens. `assertComparableCandidates` is structural (both halves are readable off the
  step), so it lands beside the missing-storage refusal rather than at run start.
- **The window doubles as the RECORD.** It is reachable as a park view only while the run is
  stopped on it, so what was compared, what was kept and under which id is also stated as a line
  in `BinaryOutputReport`: the same placement rule the artifacts follow, one decision earlier.

**Runtime symmetry is structural here rather than asserted.** Nothing new is persisted: the
comparison config rides `stepOptions`, the candidates and the choice ride `PipelineStep`, and both
facades serialise a step through the SAME `rowToExecution` mapper in `@cat-factory/server`. There
is no repository method to mirror, no migration, and no facade-specific file in the change, which
is the same argument `forkDecision` / `followUps` make. The one surface that does cross a wire is
the snapshot's `binaryGenerators.capabilities` projection, and it is built in the shared
controller both facades mount.

## The built-in Media task type, and the storage the platform ships for it

Everything above is reachable only by a deployment that writes code: it registers a generator
KIND, registers an object store as a foundational SERVICE with an OpenAPI document for it, and
builds a pipeline. That is the right shape for an org with an asset estate, and it made the
platform's most demonstrable capability the one nothing shipped could exercise. `media` closes
that: a task type, one agent kind, one preset, and a storage target that exists on every
deployment.

### What ships

- **`media`**, a built-in task type (`BUILTIN_TASK_TYPES`), defaulting to **`pl_media`**
  (`defaultPipelineIdForTaskType`) exactly as `document` defaults to `pl_document`.
- **`media`**, a `PipelinePurpose`, so a media task is offered media presets and NOTHING else
  (`pipelineAllowedForTaskType`), and the builder's palette narrows to the kinds that suit one.
  Its own member rather than a flavour of `build`: nothing here ships code, so every
  code-shipping surface (the implementation and testing palette rows, the merge tail) is wrong
  for it.
- **`media-generator`**, the FIRST built-in kind to carry `BINARY_OUTPUT_TRAIT`. Read-only over
  the checkout, opens no pull request, declares no `structuredOutput` (its deliverable is the
  fenced block in its reply), and declares `purposes: ['media']` so it appears nowhere else.
- **`pl_media`**, one step, shipping a `binaryOutput` selection rather than a blank one. That is
  forced rather than convenient: `assertValidBinaryOutputSteps` refuses a generating step with no
  storage service at SAVE and at run start, so an unconfigured preset would be one nobody could
  start until they had opened the builder. It ships `comparison` on, because generating one
  picture and keeping it is the case that never needed a pipeline. It also selects `nano-banana`,
  the one generative integration the platform registers (see below); a workspace seeded before
  that is offered the reseed by the ordinary catalog-version advisory.

### The producer: the platform's own, as the one shipped integration

`pl_media` shipped selecting a storage service and NO generative integration, which left the step
with somewhere to put pictures and no API to make them with: the agent generated through whatever
its own model could draw, or reported that it could not. `defaultBinaryGeneratorRegistry()` stayed
empty on the ground that no image API is universal and every one of them is metered, and both
halves of that are still true. Neither one decides the question the Media preset asked, which is
whether the shipped path works at all with nothing configured.

So the platform now ships ONE integration, `nano-banana` (Google's Gemini image models), in
`@cat-factory/binary-generators`: kernel + contracts only, authored through the same public
`BinaryGeneratorRegistry` seam a deployment uses, exactly as `@cat-factory/gates` is for gates.
Every facade defaults its registry to `binaryGeneratorRegistryWithBuiltins()` (both entry points
and, on the Worker, the override-less `resolveWorkerRegistries` a cron re-drive builds through),
and `pl_media`'s step selects it.

That default is what a container built with NO overrides needs, and it is only half of what the
Worker needs. It carries the PLATFORM's integrations onto the override-less builders and leaves a
DEPLOYMENT's own absent there, which is worse than the empty registry it replaced: the durable
path is where a binary-output step's dispatch brief is composed, so the brief looked populated
while carrying none of them, and a step selecting one met `binary_output_generator_invalid` on the
path nobody watches. `createApp` therefore registers an injected registry PROCESS-WIDE
(`infrastructure/binaryGenerators.ts`), the seam the binary artifact stores already used for the
identical reason, and `resolveWorkerRegistries` reads it ahead of the shipped default.

- **Metered is answered by the CREDENTIAL, not by the registry.** `GEMINI_API_KEY` resolves through
  the ordinary capability-credential path; unresolved, the agent is told the integration is
  unavailable and reports it as the reason an artifact is missing. A deployment that ignores the
  entry pays nothing and sees one extra row in a picker.
- **An INJECTED registry replaces the shipped set**, and a preset that names an id nothing answers
  to is refused at admission (`binary_output_generator_invalid`). That is the sharp edge of
  selecting by id in a shipped preset, and it is the right disposition: the alternative is a run
  that dispatches an agent with no way to generate. The facades' doc comments and the package
  README point a deployment at `binaryGeneratorRegistryWithBuiltins()` as the starting instance.
- **The id lives in `@cat-factory/contracts`** (`NANO_BANANA_GENERATOR_ID`), because two layers must
  agree about it: the definition, and kernel's seed catalog, which cannot import the package that
  defines it.
- **The rules `defineBinaryGenerator` runs are the BOOT rules**, moved into kernel
  (`binaryGeneratorDetailIssues`, `binaryGeneratorInjectionCollisions`) and called by both the
  authoring seam and `collectRegistrationProblems`. They lived inside orchestration's boot
  validator, where a definitions package could not reach them: stefka's own package restated them
  against the same leaf helpers and documented the copy as "a mirror and can drift", which is the
  thing a growing rule set cannot survive.

### The storage: the platform's own, as a `builtin`-tier service

`defaultFoundationalServiceRegistry()` returned an EMPTY registry for as long as the tier
existed, on the ground that no shared business capability is universal. That reasoning holds for
an org's estate and does not cover the platform's own storage, which every deployment already
runs for run evidence and which is the one thing a generating step cannot be configured without.
So the default now holds exactly one service, `platform-assets`, carrying
`ASSET_STORAGE_CAPABILITY` and an OpenAPI contract for an ingest API.

Nothing about it is special-cased downstream. It is selected, validated, briefed, refused and
suppressed like any other catalog id: a deployment that stores assets in its own bucket registers
that service and tombstones this one at either stored tier.

Three things are worth stating because each was a decision:

- **The bytes land in the account's binary-artifact store**, the same one screenshots use, which
  is what makes "at least one binary storage configured" the precondition rather than a new
  subsystem. A local deployment defaults that store to the FILESYSTEM
  (`contentStorageDefaultBackend: 'fs'`), so an unconfigured laptop can run the whole flow. On a
  deployment with no store at all the run is refused UP FRONT, because `media-generator` also
  carries `BINARY_STORAGE_TRAIT`: the `binary_storage_unconfigured` conflict names the fix, where
  the alternative is an agent discovering it at the end of a paid generation.
- **The endpoint is an ENVIRONMENT VARIABLE, not an OpenAPI `servers` entry.** It is per-run and
  per-transport, so a base URL written into the document would be a fact kernel cannot know and
  every deployment would read as wrong. The contract names `ARTIFACT_UPLOAD_URL` /
  `ARTIFACT_UPLOAD_TOKEN` instead, which are the harness's own variables, restated in kernel and
  pinned against it (`artifact-upload.conformity.test.ts`) because the image can import no
  workspace package. Drift there is silent in the worst way: a contract naming a variable nothing
  sets reads, through the trait guidance's own wording, as a storage outage on a deployment whose
  storage is fine.
- **The upload seam is gated on WHERE THE STEP POINTS, never on the kind.** `AgentRunContext`
  gained `binaryStorageServiceId` for exactly this: only a step storing through `platform-assets`
  is handed a credential for our ingest route, so a deployment's own generator delivering into its
  own object store never sees one. Gating on the kind or the trait would hand every generating
  step an endpoint its brief never mentioned. ONE variable carries the endpoint, and the screenshot
  seam keys off the kind's declared `ui` image, so a kind answering to both descriptions has to
  pick one: the STEP'S SELECTION wins, because the image is an inference and the selection is the
  contract the agent was actually briefed on. The other order is silent both ways, storing the
  deliverables as `kind: 'screenshot'` (which the sweep then reclaims, the exemption being per
  kind) and answering in a shape the declaration block cannot use.
- **The contract has TWO operations, and the second is what the exemption makes necessary.** A
  candidate pass STAGES several files per subject and a person keeps one; the rest are ordinary
  stored assets, and nothing reclaims an asset on a clock. Without a discard the shipped preset
  would accumulate every rejected render for the life of the workspace, and the second-phase
  brief's "remove the staged files where the storage service allows it" would resolve, on the one
  service every deployment has, to "it does not". So `DELETE /{location}` reclaims what THIS RUN
  stored: idempotent, because the brief hands the agent a list that is replayed across passes, and
  a 404 for anything else, because telling an agent it cleaned up something it did not is the one
  outcome worse than a refusal it can report.
- **A per-file ceiling is sized by the tightest runtime, not by what a generator would like to
  send.** The `BinaryArtifactStore` port takes bytes, so an ingest materialises the whole file and
  holds TWO copies at peak (the multipart body the parser keeps, and the `arrayBuffer()` read off
  the part). The Worker facade runs that inside a workerd isolate with a fixed 128 MB ceiling
  shared with everything else the invocation holds, so a limit near it does not answer 413, it
  kills the isolate mid-upload, and a Node-only test cannot tell the difference. `MAX_ASSET_BYTES`
  is 24 MiB for that reason and the budget is asserted rather than commented; raising it means
  giving the port a STREAM and every blob backend behind it one.

`asset` is its own `BinaryArtifactKind`, and the reason is RETENTION rather than taxonomy: the
age sweep is sized for run DEBRIS, and an asset is the thing the run was started to produce. A
swept one takes its step's report with it in the worst possible form, since the report goes on
naming a location, so the loss reads as a broken link rather than as a reclaim. The exemption is
`RETAINED_BINARY_ARTIFACT_KINDS`, stated as what the sweep KEEPS so a kind added later is swept
by default and has to be named to be exempted; both metadata stores build their predicate from
it, and the conformance suite asserts it at the store, which is where they can differ.

### The park a shipped preset finally made visible

`pl_media` is the first built-in whose step parks on a candidate comparison, and public-API
admission could not see it. `parkSurfacesOf` had four checks and all four read the step CHAIN,
where a comparison lives in a step's OPTIONS: `pl_media` is one `media-generator` step with no
gate flag, no parking kind, no human-wait gate and no interview trait, so every check said it
never stops. A plain `write` key was therefore admitted to START a run that then parked with
nothing on `/api/v1` able to answer it. That is the same hole `human-review` and the interview
gate each opened once before, and the lesson repeating a third time: an enumeration written
against the mechanisms somebody thought of misses the ones they did not.

So the comparison is the FIFTH mechanism, and the first that derives from what a deployment
AUTHORS rather than from what it registers. `AdmissiblePipelineShape` grew a `stepOptions` leg
narrowed to exactly the one field admission reads, so a future option cannot look like something
this module might also consult. PRESENCE of `comparison` is the whole test: authoring already
refuses one that cannot produce two candidates, so a saved comparison parks.

Answering it is a separate question from admitting it, and only the answer half is deferred. The
keep-decision has a real route, it is simply not projected onto `/api/v1`, so
`BINARY_CANDIDATE_PARK_SURFACE` stays out of `PUBLICLY_ANSWERABLE_PARK_SURFACES` and the refusal
points at the cancel path. That is the opposite reason `human-review` is absent from that set:
its answer is a person approving a pull request on the VCS host, which no API here could offer.

### What the platform holding the bytes buys, and why it is the point

An artifact in an org's private bucket is a location string: the report records it, and a reader
copies it somewhere else to find out what it is. The `binary-candidates` window has always had
the same limit, rendering whatever `previewUrl` the storage service happened to issue and saying
so when there was none.

Ours issues none either, deliberately (the bytes sit behind the workspace's own authenticated
blob route), and it does not need to: the platform can SERVE them. `platformAssetIdOf` makes the
join in the read model, from the row's own two fields, and answers null for both "stored
elsewhere" and "stored here, with a location that is not an artifact id". A location is
model-authored prose, and a paraphrased one costs the row its preview, never its record. On that
id, `StoredAssetView` renders the artifact, opens it, and hands it over to be saved elsewhere, in
the comparison window BEFORE the choice and in the step's report AFTER it.

Whether a row renders as a picture is `rendersInlineAsImage`, in `@cat-factory/contracts` and not
in either half: the server clamps its own blob responses to that list (everything else comes back
`application/octet-stream` + `attachment` + `nosniff`, which is what makes the wide upload gate
safe), and the SPA decides from it what to point an `<img>` at. Two copies disagree in both
directions, and each direction is invisible from the other end.

What it is applied TO is the media type the server SERVED, carried back beside the object URL by
`useArtifactBlobs`, never the one the producing agent declared. A stored asset has both, and only
one of them is a fact: the declaration is optional model-authored text about a file, where the
served type is the judgement the server already made about these bytes. Deciding from the
declaration is wrong in both directions, and neither shows up as an error: an undeclared PNG
renders as a generic file, and a mis-declared bundle renders a broken `<img>` reporting itself as
loaded, because the fetch genuinely succeeded. The declaration keeps the job it is good for,
labelling a non-image row with the agent's own account of what the file is.

## Remaining work

- [ ] **A worked example generator** in `backend/internal/example-custom-agent`. The harness path it
      was waiting on now exists (`transport: 'harness'`), so this is unblocked: the example should
      register a codex-served image generator and a step selecting it.
- [ ] **A conformance assertion for the harness pin**, driving a run whose model resolves to the
      wrong CLI and asserting the `generator_harness_unavailable` refusal on both facades. The rule
      is pure and unit-tested, but nothing yet pins that BOTH facades reach it through admission.
- [ ] **An `unavailable` disposition for a codex session that was never offered the tool.** Today an
      unprovisioned `image_gen` (openai/codex#28102, #37496, #19133, all open) reaches the agent as
      a tool that simply is not there, and the brief tells it to say so — which relies on the model
      reporting honestly. A platform-side signal would need the CLI to expose its resolved tool
      list, which it does not; worth revisiting when it does.
- [ ] **A conformance assertion for the capability projection** on the snapshot's
      `binaryGenerators`, alongside the existing `binaryOutput` trait one. It needs a
      `binaryGeneratorRegistry` option on the conformance harness, which no suite has needed yet;
      the projection itself is built in the shared controller both facades mount, so the gap it
      would close is a regression guard rather than a live parity risk.
- [ ] **A maximum for the reference-image count**, the sibling the value axis above names and
      holds. Flux takes eight and Grok Imagine three, both declare `multi-reference`, and a step
      handing over five is admitted and served with three. It is one field on `accepts` and one
      branch in `binaryValueCoverage`, but it is a BOUND rather than a set, so it needs its own
      predicate and its own refusal payload; worth landing beside the first deployment that
      actually holds two reference-capable integrations with different ceilings.
- [ ] **A `publicDecision` kind for the candidate park.** Every other dedicated park is projected
      onto `/api/v1` as its own decision kind, and this one is not. It is deliberately NOT added
      here, because `publicDecisionKindSchema`'s own rule is that a member ships with its routes:
      the kind needs a `keep-candidates` verb, an entry in `PUBLICLY_ANSWERABLE_PARK_SURFACES`, a
      `scripts/sdk/surface.mjs` row and a regeneration of all four SDKs plus the MCP projection.
      Until then the park is an in-app surface, and this line is the record of that. Only the
      ANSWER half is deferred: admission already refuses the start (see "The park a shipped
      preset finally made visible" above), so nothing reaches a park it cannot answer.

- [ ] **An e2e spec for the candidate park**, driving generate → park → compare → keep through the
      live pushed UI. It is the assembled-product half the unit tests cannot reach (the window is
      opened by the park classifier and settled over the stream), and it needs a fake generating
      kind in the e2e stack. The built-in `media` task type is now the cheapest way to write it:
      the stack no longer has to register a kind, a service or a pipeline of its own.
- [ ] **A per-workspace ceiling on stored assets**, beside the per-run one. `MAX_ASSETS_PER_RUN`
      bounds one container's writes, which is the runaway it exists to stop; assets are exempt
      from the age sweep, so a board generating every day accumulates without bound and only the
      account's own storage bill says so. The shape is the retention settings', not the cap's:
      it is a policy a human sets, not a number the ingest route enforces.

When that lands, convert this tracker into a numbered ADR under `backend/docs/adr/` and `git rm`
it in the same PR.

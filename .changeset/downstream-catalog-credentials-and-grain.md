---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Let a foundational service declare the credentials a step authenticates to it with, resolve the
binary-storage precondition from the step rather than the kind, record what post-processed an
artifact, and publish the pipeline-authoring seam from every facade.

**A foundational service registered IN CODE may declare `credentials`**, the same
`capabilityCredentialSchema` a generative integration and an MCP tool server declare. The engine
projects the declarations of the services a dispatch was briefed on onto
`AgentRunContext.foundationalCredentials` (key names only), `@cat-factory/server` resolves the
values through the facade-wired `ToolSecretResolver`, and the brief names the variable from the
same helper the resolver keys the job body with. `ToolSecretSubject` gains
`foundational-service`, and the credential CHECKLIST lists the new declarer beside the other two.
Until now the platform had a credential seam for what MAKES an artifact and none for where it GOES,
so a step could authenticate to eight vendors and then not to the service it had to store the
result in.

**Only the code-registered `builtin` tier may declare one.** The stored write boundary refuses a
credential on an account or workspace row (`foundational_service_credentials_not_storable`),
because the shipped resolver reads a declared key off the deployment's own environment: every other
declarer on the platform is deployment code, and a foundational service is the first one a
workspace admin can also create over REST. Per-workspace VALUES are unaffected, which is what the
sealed capability-credential store is for.

**Breaking, internal wire**: the job body's `generatorSecrets` is now `capabilitySecrets`, since
two producers share the channel, and the two resolvers became one so that a variable-name conflict
BETWEEN a generative integration and a catalog service is caught where it is visible (per job, and
now at boot as `capability_injection_name_collision`). The runner image bumps with it; a deployment
must roll the new tag before a credential of either kind reaches a job.

**The `binary-storage` precondition is resolved per STEP.** A kind carrying the trait is held to
the account's content storage only when its `binaryOutput.storageServiceId` is the platform's own
asset service (`storesThroughPlatformAssets`, the same fact the in-container upload seam reads).
`media-generator` on the shipped `pl_media` still demands it; the same kind repointed at an org's
object service no longer is, where before the refusal named a settings page unrelated to anything
the run touched. `tester-ui` makes no step-level selection and is unchanged.

**`binaryOutputArtifact.processedBy`** records what ran over the bytes AFTER the integration
produced them. A post-processed artifact has two producers and `generator` can name only one:
naming the integration records a producer of something that is not what was stored, and naming
nothing loses the vendor attribution. A free string, judged by whoever reads the run, on the same
terms as `location`.

**Every facade now exports the pipeline-authoring seam**: `definePipeline` (extracted from the
built-in catalog, which is authored with it) plus `MEDIA_GENERATOR_AGENT_KIND`,
`PLATFORM_ASSET_STORAGE_SERVICE_ID`, the two binary traits, the reserved capability tags and the
option types. A deployment replacing a shipped preset was writing five index-aligned arrays by
hand, and naming what its step selects meant either a copied string literal or a second dependency
below the facade.

**An agent kind can name its OWN container image.** The variant is a slug rather than a
three-member union: `ui` stays the platform's browser image, and anything else is a deployment's,
mapped by its runner backend (a Kubernetes pool's `imageVariants`, local Docker's
`LOCAL_HARNESS_IMAGE_VARIANTS`, a Cloudflare `[[containers]]` class bound as
`RUNNER_CONTAINER_<VARIANT>` and subclassing the newly-exported `RunContainer`). Boot refuses a
kind naming `default` or `deploy`, or a name that is not a slug; a backend with no image for a
variant refuses the dispatch rather than running the default, which for a deployment's own image
would produce a job silently missing whatever it carried.

**Bug fix**: the Kubernetes runner pool keyed its pod by run id alone, so a `tester-ui` step
re-attached to the pod an earlier step created on the base image and ran browser work without a
browser. It now keys by `containerKeyForRef`, like the Cloudflare and local backends.

**The open variant name keeps its compile-time guard.** `PLATFORM_IMAGE_VARIANTS` is a literal tuple
exporting a `PlatformImageVariant` union, `isPlatformImageVariant` narrows to it, and all three
backends split on that predicate and then switch EXHAUSTIVELY over the platform half. Opening the
type cost the `never` arm that used to make a new variant fail the build, and the three backends had
respelled the platform names inline: a fourth published image would have routed into the
deployment-owned half and been refused as unwired on the one runtime that ships it (the Kubernetes
pool would have served it the DEFAULT image silently), with nothing failing at compile time.

**A container key is refused if it cannot be read back** (`container_key_not_reversible`), and the
Apple `container` adapter refuses a container NAME the same way. Recovering the run behind a key is a
shape test, because variant names are open and the reader holds no config, so it cannot decide a run
id whose leading segment is itself a legal variant name: it splits to a run that does not exist, and
the orphan sweep then deletes a live container. Only the producer can compare against the ref, so
that is where the check lives. Nothing the platform mints today can trip it; on Apple it also catches
the name sanitiser collapsing two distinct keys onto one name.

**A credential injection-name collision is reported ONCE, over every capability registry.** The rule
moved to contracts (`credentialInjectionCollisions`, beside the injection-name fallback it is about)
and boot grades it in one section. It was graded per registry as well, so a generator-vs-generator
pair produced two problems under two codes with two remediations for one variable, while a
service-vs-service pair was graded by neither, and the cross-registry rule needed BOTH registries
wired to run at all.

**Internal break**: the boot-diagnostic code `binary_generator_injection_name_collision` is retired,
along with kernel's `binaryGeneratorInjectionCollisions`. Every collision is now
`capability_injection_name_collision`. These are boot log diagnostics, nothing persists or parses
them, and the message names the same variable and claimants as before.

**A CONTEXT service's credentials are named to the agent**, in the binary-output brief's scope
section and in its injected contract file, the way storage's already were. `briefedServiceIds`
resolves credentials for both id sets, so a context service's value was in the job env while no
layer named the variable holding it: a bearer-authenticated contract the agent could not call.

**Fixes** the local facade's harness pins, which stayed at 1.124.0 while the harness went to 1.125.0
and the job body's `generatorSecrets` became `capabilitySecrets`, so a local install on the default
pin ran an image that ignored the field and dropped every capability credential. The tag guard now
verifies EVERY pin location in `scripts/runner-images.mjs`, not just the two under `deploy/backend`.

**`LOCAL_HARNESS_IMAGE_VARIANTS` names are held to the slug shape** every declaring boundary
enforces, and a rejected entry is named in a boot warning. `Pixel-Tools=…` parsed into the map,
matched no declaration a kind could have made, and the dispatch was then refused pointing at the
variable the operator had already set it in.

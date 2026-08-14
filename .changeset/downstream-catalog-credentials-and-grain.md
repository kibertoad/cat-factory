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

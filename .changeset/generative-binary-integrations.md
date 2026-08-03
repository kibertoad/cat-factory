---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Register generative binary integrations (image / music / video generation APIs) in a deployment's own code, and let binary-generating agent steps select them.

`BinaryGeneratorRegistry` is a new app-owned registry beside the foundational-service one: an integration declares the content types it produces (`image | audio | video | 3d | document`), its media types, endpoint, API contracts and the credential it needs BY NAME. A step picks from it via `stepOptions.binaryOutput.generatorIds` and states the content types it must deliver via `.modalities`; run admission refuses an unregistered id or an uncovered content type under the new `binary_output_generator_invalid` conflict reason. The agent's `.cat-context/binary-output/brief.md` now leads with a Generation section describing each integration, and the credential value reaches only that job's agent process (job body `generatorSecrets`), never a prompt or the telemetry snapshot.

All three facades take the registry as their own DI option (`binaryGeneratorRegistry`), so a deployment registers integrations on Node and local exactly as on the Worker, and each facade boot-validates the instance it was handed. A new `registry-seams` guard derives the app-owned registry set from `CoreDependencies` and holds each one to a declared route, so the next registry cannot land threaded on one runtime and inert on another.

The SPA follows the shapes through: the binary-output step picker offers the generative selection (from the workspace snapshot's new `binaryGenerators`, identity only — never a credential key name) and mirrors both new refusals inline, and the report names the integration that produced each artifact plus any the deployment does not register.

Breaking, pre-1.0: `PipelineStep.binaryOutputs` gains a required `unknownGenerators` array, so reports recorded before this change no longer parse — an affected step's declaration record is re-created on its next run. `ToolSecretResolver.resolve` takes a discriminated `subject` (`tool-server` | `binary-generator`) in place of `serverId`; a deployment implementing that port per workspace must update its signature, and one passing `allowKeys` to the env-backed default must extend the list to cover its integrations' credential keys or they resolve to nothing.

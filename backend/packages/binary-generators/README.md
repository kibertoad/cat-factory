# @cat-factory/binary-generators

The **generative binary integrations** the platform ships, plus the seam a deployment writes its
own with. These are the metered vendor APIs a [binary-output step](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/binary-output-foundational-storage.md)
calls to _produce_ its artifacts, as opposed to the foundational service the artifacts are then
_stored_ through.

| id            | What it makes                                                          | Modalities                          |
| ------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `nano-banana` | Images with legible text in them, and conversational editing, up to 4K | `image` (`image/png`, `image/jpeg`) |

## Why the platform ships one at all

`defaultBinaryGeneratorRegistry()` is still empty, and the reasoning that kept it empty still
holds: no image API is one every organisation runs, and every one of them is metered. What changed
is the Media task type. It ships a generating agent kind, a preset and the storage underneath, and
its step selected nothing, so the platform's most demonstrable capability was reachable only by a
deployment that first wrote an integration, an OpenAPI document and a credential declaration.

Metered is answered by the credential rather than by the registry. With no key resolved the agent
is told the integration is unavailable and reports it as the reason an artifact is missing, so a
deployment that ignores this package pays nothing and sees one extra row in a picker.

## Using it

Every facade defaults its registry to the shipped set, so nothing is needed to get `nano-banana`:

```ts
await start({/* … */}) // binaryGeneratorRegistry defaults to binaryGeneratorRegistryWithBuiltins()
```

An **injected** registry REPLACES the default rather than merging with it, so a deployment adding
its own integrations starts from the built-ins:

```ts
import { binaryGeneratorRegistryWithBuiltins } from '@cat-factory/node-server'

const binaryGeneratorRegistry = binaryGeneratorRegistryWithBuiltins()
binaryGeneratorRegistry.registerAll(myIntegrations)
await start({ binaryGeneratorRegistry })
```

That matters more here than for the gate or prompt-fragment registries, because the shipped
`pl_media` preset SELECTS `nano-banana` by id: a registry without it refuses that pipeline's runs
at admission (`binary_output_generator_invalid`) rather than degrading quietly. Dropping the
shipped integration is a legitimate choice; editing that preset's step is the other half of it.

Register **once per deployment**, on the process that owns the registry. In mothership mode that is
the mothership: a node resolves integrations over `/internal/binary-generators` and consults no
registry of its own, so the set the pipeline builder offers and the set admission resolves are one
set however far behind the node's build has drifted.

On the **Worker** the registry is also held process-wide
(`infrastructure/binaryGenerators.ts`), the same way the deployment's binary artifact stores are
and for the same reason: that runtime builds a container per entry point, and a binary-output
step's dispatch brief is composed on the durable path, which takes no options at all.
`createWorker({ overrides: { binaryGeneratorRegistry } })` registers on your behalf, so a
deployment using the documented seam needs to know none of that. What made this one easy to miss
is that an override-less build resolves the SHIPPED set rather than nothing, so an unregistered
integration is absent from a brief that otherwise looks populated.

## The credential

`nano-banana` authenticates with `GEMINI_API_KEY`, an API key from
[Google AI Studio](https://aistudio.google.com/apikey), sent as the `x-goog-api-key` header. The
name is the vendor's own, so an agent reaching for `google-genai` finds the value where the library
looks.

Set it either as a workspace **capability credential** (subject `binary-generator`, id
`nano-banana`, key `GEMINI_API_KEY`) or in the environment the deployment dispatches runs from. The
value travels on the job body alone and is injected into the agent's process for that job; it is
never written to the checkout, the prompt or a log.

Do **not** add it to `docs/environment-variables.md`: every variable documented there is reserved
by `check-reserved-env-keys.mjs`, which would make this key unresolvable.

Billing must be enabled on the Google project. None of these models has a free tier, so an
unbilled key gets `FAILED_PRECONDITION` on the first call, which the agent reports as the reason
nothing was generated.

## Writing your own

`defineBinaryGenerator` is exported for exactly this, and re-exported from each facade so a
deployment reaches it from the package it already depends on. It runs the platform's OWN
registration rules at import (the definition schema, plus `binaryGeneratorDetailIssues`: the
endpoint policy, the contract-set rules, the media-type classifier, the harness check and the
capability-versus-accepted-values pairing), so a definition that would fail a boot fails a test
instead:

```ts
import { defineBinaryGenerator, openApiContract } from '@cat-factory/binary-generators'

export const acmeImages = defineBinaryGenerator({
  id: 'acme-images',
  name: 'Acme Images',
  summary: 'One line the picker and the agent brief show.',
  description: 'What it is good at, what it is NOT for, and its cost profile.',
  modalities: ['image'],
  mediaTypes: ['image/png'],
  capabilities: ['seed', 'exact-size'],
  endpoint: 'https://api.acme.example',
  credentials: [{ key: 'ACME_IMAGE_API_KEY', usage: 'Authorization: Bearer <value>' }],
  contracts: [
    openApiContract({ contractId: 'acme-api', title: 'Acme API', document: ACME_OPENAPI }),
  ],
  guidance: 'Operating notes folded into the agent’s brief verbatim.',
})
```

Two rules the seam cannot check for you, both pinned per integration in the tests here:

- **A capability is a claim about the endpoint's REQUEST.** Declare one only where the registered
  contract carries the parameter, or a step is admitted and the agent is left holding an option it
  cannot send. `nano-banana.test.ts` names each capability's evidence in the document.
- **An `accepts` set is a REFUSAL.** State one only where the endpoint genuinely enumerates its
  values, and read it off the contract rather than restating it, so the two cannot drift.

Everything that does not gate an option ("good at pixel art", "cheap below 2K", "rate limited to
five a second") stays prose in `description` and `guidance`, where a sentence can say what it means.

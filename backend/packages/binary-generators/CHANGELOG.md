# @cat-factory/binary-generators

## 0.2.7

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 0.2.6

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.2.5

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 0.2.4

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 0.2.3

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.2.2

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.2.1

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.2.0

### Minor Changes

- 053aac8: Ship Nano Banana as the platform's first generative binary integration, and hook the built-in Media
  pipeline to it.

  `@cat-factory/binary-generators` is a new package holding the definition (Google's Gemini image
  models, with the OpenAPI contract a run's agent reads) and `defineBinaryGenerator`, the authoring
  seam a deployment writes its own integrations with. It runs the platform's OWN registration rules at
  import, now shared from kernel (`binaryGeneratorDetailIssues`, `binaryGeneratorInjectionCollisions`)
  rather than reachable only inside orchestration's boot validator.

  Every facade now defaults `binaryGeneratorRegistry` to `binaryGeneratorRegistryWithBuiltins()`, and
  the shipped `pl_media` preset selects `nano-banana`, so a Media task generates images once
  `GEMINI_API_KEY` is set as a capability credential and nothing else is configured.

  **For a deployment that injects its own `binaryGeneratorRegistry`**: an injected instance replaces
  the shipped set rather than merging with it, so `pl_media` would then select an id nothing answers
  to and its runs are refused at admission (`binary_output_generator_invalid`). Start from
  `binaryGeneratorRegistryWithBuiltins()` and register onto that instance, or edit the preset's step.

  On the **Worker**, an injected registry is now registered process-wide by `createApp`, which is what
  carries it to the entry points that take no options. A binary-output step's dispatch brief is
  composed by the durable driver, so before this a deployment's own integrations were absent from
  every brief it built while the platform's shipped one was present.

  `PLATFORM_FOUNDATIONAL_SERVICES` is a new kernel export: the frozen definitions
  `defaultFoundationalServiceRegistry()` seeds from, shared across registries rather than copied per
  one. A caller can now tell the platform's own service from a deployment's replacement of the same
  id, which is what the local facade's mothership boot warnings need. Both of them (the estate and the
  generative integrations) report only what the deployment registered, and report a shipped id a
  deployment REPLACED, which subtracting by id could not see.

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

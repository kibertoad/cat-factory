# `@cat-factory/binary-generators`: the built-in generative binary integrations

The platform's own generative integration (`nano-banana`, Google's Gemini image models) plus the
authoring seam a deployment writes its own with, **entirely through the public
binary-generator-registry seam**: kernel + contracts only, never the engine. The same dogfood
`@cat-factory/gates` is, on the registry a binary-output step selects its producers from.

**Entry:** `src/index.ts`. It exposes `binaryGeneratorRegistryWithBuiltins()` (the one-call factory
a composition root reaches for: a fresh app-owned `BinaryGeneratorRegistry` pre-loaded with the
shipped set, which every facade defaults `CoreDependencies.binaryGeneratorRegistry` to; there is NO
module-load side effect), its lower-level `registerBuiltinBinaryGenerators(registry)`, the
`BUILTIN_BINARY_GENERATORS` catalog, and `defineBinaryGenerator` / `openApiContract`, the authoring
pair also re-exported from each facade.

**Where things live:** `define.ts` (the authoring seam, which runs the platform's own registration
rules at import), `generators/nano-banana.ts` (the definition: what it produces, what a step may
ask it for, the credential, the brief guidance), `contracts/nano-banana.openapi.ts` (the OpenAPI
document rendered into the agent's `.cat-context/`), `index.ts` (the catalog + registry factory).

**Traps:**

- **An INJECTED registry replaces this set rather than merging with it**, and the shipped `pl_media`
  preset selects `nano-banana` by id, so a deployment that news a bare `defaultBinaryGeneratorRegistry()`
  turns that preset's runs into an admission refusal. Start from `binaryGeneratorRegistryWithBuiltins()`.
- **A capability is a claim about the endpoint's REQUEST, and an `accepts` set is a REFUSAL.**
  Neither is checkable by a schema, so both are pinned against the contract document in
  `generators/nano-banana.test.ts`, the aspect ratios by reading the document's own enum.
- **The credential's key is a boundary.** `GEMINI_API_KEY` must stay outside
  `isReservedPlatformEnvKey`, which the tests assert: inside a reserved family the lookup resolves
  nothing, and "no credential" is indistinguishable from an unset variable everywhere downstream.
  For the same reason it is never documented in `docs/environment-variables.md`.
- **The id is owned by `@cat-factory/contracts`** (`NANO_BANANA_GENERATOR_ID`), because kernel's
  seed catalog selects it and cannot import this package.

**See also:** `CLAUDE.md` → "Binary-output steps";
[`binary-output-foundational-storage.md`](../../../docs/initiatives/binary-output-foundational-storage.md)
(the whole model); kernel `domain/binary-generator-registration.ts` (the rules `defineBinaryGenerator`
runs, shared with the boot validator); [its README](./README.md) (using it, and writing your own).

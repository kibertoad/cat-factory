# `@cat-factory/prompt-fragments`: versioned best-practice prompt fragments

Curated, versioned best-practice fragments injected into agent system prompts. **See
[README.md](./README.md).**

**Entry:** `src/index.ts`; the fragment bodies live under `src/collections/`. The
deployment-programmatic seam is NOT here any more: it is the app-owned `PromptFragmentRegistry`
(kernel `domain/prompt-fragment-registry.ts`), and this package's job at the entry is
`promptFragmentRegistryWithBuiltins()`, which installs the shipped catalog plus
`BUILTIN_TASK_TYPE_DEFAULTS` (`src/task-type-defaults.ts`) onto one through the same public methods
a deployment uses. `getFragment` remains, narrowed to the SHIPPED catalog, for the paths with no
registry in hand. A deployment's own namespaced task type carries its standing context on its OWN
registration (`CustomTaskType.defaultFragmentIds` / `conditionalFragmentIds`, boot-validated): see
[`backend/docs/reusable-operations.md`](../../docs/reusable-operations.md).

**Why a registry rather than the module globals it replaced:** they were correct only while every
reader resolved the same physical copy of this package, which the published dependency graph does
not guarantee (a `workspace:*` dep publishes as an EXACT version), and the failure was silent.

---
'@cat-factory/orchestration': patch
---

Refactor the domain composition root (`createCore`) onto a typed optional-module registry
(refactoring-candidates.md #6). Each optional module is now `build(key, factory)`-declared once
through `ModuleRegistry` and emitted in one place via `...modules.assemble()`, replacing the ~40
`const x = createX(...)` locals + matching `...(x ? { x } : {})` return spreads. `Core` splits into
`CoreSpine` (always present) + `OptionalCoreModules` (registry-assembled), and the ~30
`createXModule` factories moved to `container/modules.ts`, cutting `container.ts` from ~3,019 to
~1,890 lines. Behaviour is unchanged (same wiring, same order); verified by the orchestration suite

- cross-runtime conformance.

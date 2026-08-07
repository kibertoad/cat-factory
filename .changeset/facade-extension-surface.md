---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/app': patch
---

Make a runtime facade the whole extension surface a deployment needs.

Each facade now re-exports the CONSTRUCTOR and the types for every app-owned registry it lets a
deployment inject, not only the option that takes one. `gateRegistry`, `judgeRegistry`,
`stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry` were reachable options with no
exported way to build a value, so the only route was a direct dependency on `@cat-factory/kernel` /
`@cat-factory/gates` / `@cat-factory/prompt-fragments`, which publish at exact versions, so
floating one past what the facade pins resolves a second physical copy and the registration lands
where nothing reads it. The reusable-operation authoring types (`CustomTaskType`,
`TaskTypePresentation`, `TaskTypeFieldDescriptor`, `TaskTypeFieldOption`, the shared
`DescriptorField*` shapes, `PromptFragment`), the four descriptor helpers, the built-in
`*_PIPELINE_ID` constants and `RegistrationProblem` come with them.

`start()` / `startLocal()` / `createWorker()` take an `escalateRegistrationWarning` predicate,
raising selected boot-validation warnings to errors. Boot must WARN on an unresolvable
`defaultFragmentIds` id because it cannot tell a typo from an account/workspace-tier id that merges
per workspace at run time; a deployment whose operations reference only fragments it registers
itself knows that second cause does not apply, and can now say so instead of re-deriving the check
in its own test suite.

Additive throughout: no existing registration, option or export changes shape.

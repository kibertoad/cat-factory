---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/example-custom-agent': minor
'@cat-factory/app': minor
---

Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
one, and a custom task type's collected values are now checked against what it declares.

An initiative preset and a custom task type had grown the same feature twice, and the task type was
the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
validation, and two near-identical Vue renderers. So a form an org could express as a preset was
unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
each surface declaring only which input types it admits. `password` is excluded for a task type by
construction rather than by convention: a collected value is folded into prompts, projected onto the
board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

`taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
multi-select `string[]`). A pure widening, so every existing row parses unchanged and there is
nothing to migrate; the prompt fold renders the new shapes through the same renderer the form review
uses, so a multi-select reads as its option captions rather than its stored enum values.

`BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
public-API slice) a headless caller. Three cases deliberately pass through unchecked: a built-in type
(schema-typed fields, already validated), a type this process does not register (a supported row,
since task types are node-local by design and degrading data must not brick creation), and a
descriptor declaring a bespoke `formPanel`, which owns its own bag.

The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
`select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
would hide that field forever). Each is fully known from the registration and silent at run time,
unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
at boot.

Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
than a button row, since it is now the shared renderer, and a form with many options needed that
anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
carrying each locale's existing translation.

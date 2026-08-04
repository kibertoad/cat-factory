---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/example-custom-agent': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
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
multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
form review uses, so a multi-select reads as its option captions rather than its stored enum values.
Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
cannot exceed the same bound) is refused on the way in.

`BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
that registers an operation with required fields**: any path creating such a task without its
parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
built-in type (schema-typed fields, already validated), a type this process does not register (a
supported row, since task types are node-local by design and degrading data must not brick
creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
`select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
would hide that field forever). Each is fully known from the registration and silent at run time,
unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
validated at boot for the first time (all three facades pass the registry).

Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
than a button row, since it is now the shared renderer, and a form with many options needed that
anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
carrying each locale's existing translation.

One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
reached the freeze having passed no type check; sanitization now drops them, which stops a
wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
`Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
default-ON toggle and the one unfilled value that is an answer.

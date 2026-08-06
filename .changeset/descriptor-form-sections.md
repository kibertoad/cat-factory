---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

A descriptor-driven form groups under section captions

The last open gap from the extension-seam report an org build filed against the published packages: a
reusable operation that collects thirteen fields, every one of which changes what the agents do,
rendered as one undifferentiated column. `DescriptorFields.vue` walked `fields` in declaration order
and the vocabulary had no grouping attribute, so the only way to signal structure was to bury it in
each `label`.

A field may now carry `section`, the caption its run of fields renders under. It sits on the SHARED
`descriptorFieldEntries` spread, so both declaring surfaces (a custom task type's per-case form and
an initiative preset's create form) gain it at once and cannot drift, and the gate-config form the
pipeline builder renders through the same component gets it for free. It is presentation and nothing
else: validation, what is frozen on the entity, and the prompt fold are all untouched, so moving a
field between sections can never change what the platform does with its answer.

The grouping RULE lives in contracts (`descriptorFieldSections`) rather than in the renderer, because
two readers depend on it. Visibility is applied BEFORE the runs are cut, which is what makes a
section whose every field is hidden by `showWhen` render no caption at all (a caption over nothing
reads as a form that failed to load its own controls) and what keeps a hidden field between two
fields of one section from splitting its caption in half. Two spellings of one caption fold together
on case and whitespace, exactly as the task-type picker's category rows do, and the first spelling is
the one rendered, because a caption is the deployment's own words rather than an id.

Declaration order is never rearranged, and that is what makes the second reader a boot ERROR
(`task_type_field_section_interleaved` and its `initiative_preset_` / `gate_` siblings, through the
same `descriptorFormProblems` checker every declaring surface shares). A section a form can be made to
caption twice has no honest rendering: the caption prints twice, which reads as a platform fault
rather than as the declaration it is, and the alternative repair moves a field away from where its
author wrote it. Refusing the declaration at boot is the only disposition that leaves the renderer
free of a repair nobody asked for, and it is the bar the surrounding checks already hold registrations
to (error on what is fully knowable from the registration).

What that check judges is REACHABILITY, never contiguity in the declared list, because the reduction
it mirrors applies visibility before it cuts the runs. A branching form is written with its branches
interleaved (each branch's fields beside the picker they qualify), so a section is reported only on
finding a concrete state that prints it twice: two of its fields with a differently-captioned field
between them that can be on screen beside both. For the single-condition vocabulary that is decidable
pairwise, since the only contradictions available are two `equals` on one key and an `equals` against
an `includes`. Reading contiguity alone would fail a deployment's boot outright over a form no user
can break, which is a far worse failure than the duplicate caption it is guarding.

The third surface reaching that checker is new here: a registered GATE's per-step config form
rendered through the same component, which had none of these checks behind it, so a gate could boot
clean and print the duplicate caption the platform calls its own fault (along with unchecked duplicate
keys, optionless pickers and out-of-options defaults). It declares its form as an option on
`GateRegistry.register` rather than as a field of a descriptor type, which is why nothing at the call
site read as a descriptor form; the code prefix is now a named union so the next such surface has to
be added deliberately.

Reviewing: the interesting question is that severity, since grouping is cosmetic and every other
error in that checker is a form that cannot be filled. The renderer's own behaviour for an
interleaved declaration is still defined and total, because it has to be for a wire descriptor from a
node whose build differs.

One rendering constraint is worth knowing before touching the component: the captioned runs render
FLAT, with each run's caption on the field that opens it, never as a per-run wrapper element. Run
membership shifts as `showWhen` reveals fields while a field's identity does not, so nesting the
fields inside a wrapper re-parents them when a boundary moves, and Vue can only do that by remounting
them. The remounted input is the one being typed into, because typing into the trigger is what moved
the boundary.

`section` reaches `/api/v1` through `GET /api/v1/task-types`, so the surface version steps to
`1.20.0` and the SDKs are regenerated. Additive per ADR 0034: it groups nothing the create call
validates, so a client that ignores it fills exactly the same bag as before.

With this the `deployment-extension-seam-gaps` tracker's committed scope is complete, so it converts
to [ADR 0040](../backend/docs/adr/0040-deployment-extension-seam-reachability.md). The one item that
does NOT land is the deployment-scoped document source, declined rather than deferred: the account
tier already serves an org-wide living document, and the boot error added earlier in that initiative
names that path at the moment a deployment reaches for the wrong one.

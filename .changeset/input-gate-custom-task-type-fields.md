---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

The pre-dispatch input gate now judges a CUSTOM task type's own required fields, so a deployment
registering its own work items gets the same free refusal the built-in types get.

It reads the declaration the type ALREADY makes — its create-form field descriptors' `required`
markers — through the same rule the create form's validator uses, rather than adding a second
place to say it. That is the whole design: the two doors agree by construction, which is also why
the gate takes the same two stand-downs the create door takes (an unregistered type declares
nothing; a `formPanel` type has a bespoke section owning the whole bag). `showWhen` is honoured,
so a field the form would have hidden is never required.

What the gate adds over the create door is WHEN it asks. The create check fires once, against the
declaration as it stood that day, on the paths that reach `addTask`. The gate fires at every run
against the declaration as it stands now, so a requirement added in a later release reaches the
tasks that predate it, and a task created on a node that never registered the type is judged
where it runs.

One new finding code covers every deployment's every type (`required_field_missing`), with WHICH
field carried on the finding — a `key` for a machine and the deployment's own `label` for a
human. The codes are a closed, persisted vocabulary, so an org registering twenty operations adds
nothing to it. Additive on the wire: the `field` is optional and the code is a new enum member,
so the SDKs tolerate it by design (OpenAPI `info.version` 1.8.0 → 1.9.0).

Reviewer note: findings are one per unanswered field rather than collapsed, because three
missing inputs are three things to go and do.

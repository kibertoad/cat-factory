---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Let a headless caller repair the input the platform itself refused.

`PATCH /api/v1/tasks/:taskId` accepts `fields`, the task's per-type bag, checked against the same
descriptors `GET /api/v1/task-types` serves and refused the same way (`422`,
`details.reason: 'task_type_fields_invalid'`, every problem at once). Four of the pre-dispatch input
gate's seven issue codes name a field of that bag, and it was accepted at creation and nowhere else,
so the platform could accept a task, refuse to run it, name precisely what to go and fix, and leave
a caller with `proceed` (waiving the finding) or deleting a task whose id every stored reference
points at. OpenAPI `info.version` 1.24.0; all four SDKs and the MCP facade regenerated.

The public `fields` MERGES over what the task carries where the internal patch keys replace, because
this API does not serve the bag back: a deployment's own type may declare a `password` field, so
there is no read surface to restate values from. Three rules keep that merge from judging or
rewriting what the caller never sent:

- Only the keys a request NAMES are checked against the descriptors. A stored value was admitted by
  another authority (the public descriptors for a built-in type restate `taskTypeFieldsSchema` more
  narrowly, and a deployment may re-register a custom type under tighter bounds), so re-judging it
  refuses the patch for something it did not do, identically every time. Completeness (`required`)
  is still judged on the merged result.
- Alternate SPELLINGS of one value supersede each other. A `review` task's target is `prNumber` or
  `prUrl`; merging the stored number back in beside a caller's URL would outrank it and silently
  revert the target.
- A description arriving with the patch has the fold it already carries REPLACED rather than
  prepended to. The read surface serves the folded description, so a read-modify-write client
  returns it, and prepending left the task naming two different pull requests.

Internally the per-type bag is now patched through two keys that each replace their own half:
`customTaskTypeFields` (unchanged) and a new `builtinTaskTypeFields`, validated by the schema rather
than by a deployment's descriptor. A `review` task's target repeats creation's own resolution on the
patch path (the pull request is verified against the provider and the confirmed reference re-folded
into the description); where the description has since been rewritten by hand, moving the target is
refused rather than left naming a pull request the run does not review.

Also retires a stale caveat on the visual-confirmation decision, which told callers the screenshots
and reference designs were not readable over `/api/v1`. They have been readable since the artifact
blob endpoint shipped: it is keyed on the artifact alone, so it serves both anchors.

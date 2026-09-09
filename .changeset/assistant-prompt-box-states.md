---
'@cat-factory/contracts': patch
'@cat-factory/app': patch
---

Offer the assistant's prompt box only once its capability has answered, and say so when it cannot

The assistant opened with a narrow three-row box, no examples, and a Run button that stayed disabled
no matter what was typed. The cause is a trap for every lazily mounted panel in this SPA: the page
mounts the modal only while its open flag is set, so the component's `open` is already true at
setup, and the change-only watcher that read `GET /assistant` never fired. Nothing ever read the
capability, so the store held no actions and `available` stayed false, which the modal rendered as a
prompt box with a dead button and nothing said about why.

Fixing the read is one flag. The reason the failure was invisible is the part worth reviewing: a
null capability was carrying three different facts (nobody asked, the read is in flight, the read
failed), and a fourth answer, "read, and this deployment wired no model", was the only one the modal
could actually describe. The read now tracks its own progress and the modal derives one of four
surfaces from it, so waiting looks like waiting, a failed read offers a retry, and an unconfigured
deployment gets the sentence about configuring a provider that was already written for it.

A disabled button owes a reason on the same principle. The empty box is answered by its placeholder
and the examples under it, and an over-long request now names both numbers instead of being refused
by the backend on submit. The cap is exported from the contracts package (`ASSISTANT_PROMPT_MAX`)
rather than retyped in the SPA, since a box promising a different limit from the schema's would
refuse requests the backend would take.

The box itself is now full width and six rows growing to fourteen, which is what the screenshot that
prompted this showed first: `UTextarea`'s root is `inline-flex`, so a box with no `w-full` sizes
itself to nothing in a block container.

Worth watching: the same non-immediate `watch(open)` shape remains in a handful of other lazily
mounted modals (`BugHuntModal`, `TaskImportModal`, `RecurringPipelineModal`, the two source-connect
modals, `InfrastructureWindow`, `StartFromDesignModal`). Most only reset state that is already at
its default, but the first three seed their defaults there, so they open with an unselected picker
and a disabled confirm. That sweep is deliberately not in this change.

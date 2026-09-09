---
'@cat-factory/contracts': patch
'@cat-factory/app': patch
---

Say what the assistant can do here, instead of offering a box that cannot submit

The assistant opened with a narrow three-row box, no examples, and a Run button that stayed disabled
no matter what was typed. The cause is a trap for every lazily mounted panel in this SPA: the page
mounts a modal only while its open flag is set, so the component's `open` is already true at setup,
and the change-only watcher that read `GET /assistant` never fired. Nothing ever read the
capability, so the store held no actions and `available` stayed false, which the modal rendered as a
prompt box with a dead button and nothing said about why.

That trap is now closed for the whole SPA rather than at the one site that got reported.
`onModalOpen(open, fn)` is the shared seam, and every panel that seeds state or issues a read on the
way in goes through it: `BugHuntModal` and `TaskImportModal` were carrying the same live bug (both
opened with an unselected picker and never loaded their sources), and four more were one edit away
from it. The rule is written up where a modal author reads it, in the frontend README.

The reason the failure was invisible is the part worth reviewing. A null capability was carrying
three different facts (nobody asked, the read is in flight, the read failed), and a fourth answer,
"read, and this deployment wired no model", was the only one the modal could describe. The modal now
derives its surface from the ANSWER: an unwired deployment, an empty action catalog and a failed
read are three panels with three different remedies, and the empty catalog is not folded into the
unwired case because every submit against it is refused with `assistant_no_actions`.

A read still in flight is deliberately not one of those panels. It shows the box with Run disabled
and the wait stated beside it, because withholding the box until the read lands drops the characters
typed in the gap: the assistant is opened from the sidebar and the command palette, where the hands
are already on the keyboard. A re-open keeps the answer it already holds while the re-read runs, so
the box does not flash back to a spinner for a fact the store can state.

A disabled Run owes a reason, and it owes it to a reader who cannot see the sentence too: the reason
line is a live region named by the button. The prompt cap is exported from the contracts package
(`ASSISTANT_PROMPT_MAX`) rather than retyped in the SPA, and the per-argument cap is now its own
constant, since pointing both at one number made either unmovable.

The assistant's agent kind now appears in the Model Defaults panel, beside Kaizen and the fixers.
It already resolved the workspace preset's base model like every other kind (that is now pinned by
tests rather than assumed); what it lacked was the row an operator pins a different model on, and a
label anywhere a spend rollup names the kind that spent it.

Worth watching: the capability read carries its own deadline and aborts what it gives up on, because
the shared client sets no timeout and a stalled read would otherwise leave the modal with no answer,
no failure, and so no retry either. Its failure is reported by the panel rather than the toast
funnel, which is a deliberate exception to the funnel rule: the panel is where the retry is, and a
toast would stack a second non-dismissing copy of the same sentence on every attempt.

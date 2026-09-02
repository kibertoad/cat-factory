---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Let the monorepo adoption survey choose what it reads, and record what it read.

The survey behind a monorepo bootstrap's adoption suggestion used to read a DECLARED list of
files (the root convention files, up to two CI workflows, one probed sibling service) and hand
them to one model call to judge. What the survey could not see was therefore decided before it
looked. It could see a sibling's dependency on `@acme/service-base` but not what adopting it
entails; it could name one sibling but had no shape in which to say the siblings disagree; it
saw nothing below a sibling's top level; and it read whichever two CI workflows sorted first,
which is unlikely to be the one that will actually gate the pull request.

The read is now a bounded tool loop. The platform still seeds an opening context (each side's
root listing and convention files, the CI directory listed rather than sampled, and the listing
of every sibling holding a convention file of its own), and the model then asks for what it
needs through `list`/`read` tools bound per side over the same checkout-free `RepoFiles`. It is
still inline: no container, no clone, no runner-image change.

The platform keeps the bookkeeping, which is what keeps the suggestion checkable. Every read,
seeded or model-chosen, is budgeted (24 model reads, 54 000 characters for the loop), scrubbed
of secrets and appended to one transcript, and a recommendation citing anything that transcript
does not hold as read is still dropped and reported. Exhausting a budget is stated to the model
so the plan can name the areas it ran short on, and reported on the plan so a reviewer can tell
a thin read from a thin reading.

`AdoptionSurvey` is now that transcript: `reads` replaces `monorepoPaths`/`templatePaths`/
`unreadablePaths`, `siblingServices` replaces the single `siblingService`, and `exploration`
carries the budget. Internal wire shape, so a plan stored by an older build reads back
unusable and the run should be retried; nothing about the review, the park or the pull request
changes.

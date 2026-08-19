---
'@cat-factory/agents': minor
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
---

Skills declare a group, and a review task can queue review skills onto its run.

A `SKILL.md` may now declare `group:` (`build`, `review`, `test`, `write`, `plan`, `operate`,
`other`), which is what lets a surface offer the part of the catalog that fits it. A manifest that
declares nothing, or a value this build does not know, reads as `other`, and the account library
shows the declared value beside it so the author can fix their frontmatter.

A `review` task carries an ordered queue of `review`-group skills (`taskTypeFields.reviewSkillIds`,
capped at 8), picked in the create-task form. The engine resolves them onto the reviewer's own
skills at dispatch, so the harness installs a team's Performance Review or Security Review playbook
exactly as it installs a `skill` step's pick, and each version is pinned on the step. Which agent
receives the queue is the new `review-skills` trait, carried by `pr-reviewer`.

A queued skill that has left the catalog FAILS the dispatch rather than being skipped: a review
that quietly dropped the security lens it was asked for reads exactly like a clean one.

Internal break: `AccountSkillRecord` gains a required `group`, and `account_skills` gains a
`skill_group` column defaulting to `other` on both runtimes. Existing rows are rewritten from their
manifests on the next sync of their source. The public API's task-field table is unchanged.

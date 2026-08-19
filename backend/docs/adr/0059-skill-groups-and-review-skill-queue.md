# ADR 0059: Skill groups, and the review task's skill queue

- Status: accepted
- Date: 2026-08-19
- Context layer: `@cat-factory/contracts` + kernel (the skill record) + `@cat-factory/agents`
  (manifest parse, catalog projection, the `review-skills` trait) + orchestration (dispatch-time
  resolution) + `@cat-factory/server` + both runtime facades + the SPA

Extends [ADR 0024](./0024-repo-sourced-claude-skills.md) (how a skill is authored, synced and
run) and [ADR 0023](./0023-pr-deep-review.md) (what a review task does).

## Context

A `review` task runs one read-only `pr-reviewer` over an existing pull request. What that reviewer
judges by is fixed: its own role prompt plus the task's best-practice fragments, which are passive
guidance rather than a procedure. A team that has written down HOW it audits a change for
performance, or for security, or for accessibility, had no way to say "apply that procedure to
this pull request". The two shapes the platform already offered both miss:

- A `skill` STEP runs a playbook, but it is a `container-coding` kind that commits: it is the
  wrong thing entirely for a read-only audit, and it would need its own pipeline per lens.
- An agent kind can DECLARE skills (ADR 0029), but that is a deployment-static statement. Which
  lens a pull request needs is a per-review judgement: this one touches auth, that one touches a
  hot path.

The second problem is the picker. Once a catalog holds a few dozen skills, "which of these is a
review playbook" is unanswerable from a flat list of names, and a surface that offers skills has
nothing to filter on. A picker that offers the whole catalog for a review is how a release-notes
writer ends up queued onto a security audit.

## Decision

**Skills declare a GROUP, and a review task carries a QUEUE of them.**

- **Group.** `SKILL.md` frontmatter gains an optional `group:` (`build` | `review` | `test` |
  `write` | `plan` | `operate` | `other`), persisted on `account_skills.skill_group` as the RAW
  declared value and narrowed at the read boundary by `normalizeSkillGroup`. A manifest that
  declares nothing, or declares a value this build does not know, reads as `other`; the management
  surface renders the declared value beside it (`AccountSkill.declaredGroup`) so an author sees
  what they wrote. The group rides the snapshot's `SkillSummary`, so the SPA filters on the
  classification the backend already made.
- **Queue.** `taskTypeFields.reviewSkillIds` is an ordered, capped (8) list of catalog skill ids,
  picked at task creation from the `review` group alone. At dispatch the engine resolves them onto
  `AgentRunContext.skills`, where the existing harness-aware delivery installs them exactly as it
  installs a `skill` step's pick, and pins each version onto the step like any other catalog skill.
- **Who receives it** is the `review-skills` TRAIT, carried today by `pr-reviewer` alone. The
  reviewer's slice-dispatch guidance tells it to route each queued skill to the slices its scope
  covers, rather than paying for every lens on every slice.
- **A queued skill that cannot resolve FAILS the dispatch**, with a message naming the task's
  queue. `SkillRunResolver` now states only the FACT (the skill is gone) and the engine appends the
  remedy, because the surface a human edits differs by where the id was picked.

## Rationale

- **A group is a shelf, not a taxonomy.** Deliberately coarse and closed: "Performance review" and
  "Security review" both shelve under `review`, and what distinguishes them is the name and
  description the picker already shows. A rich taxonomy would be a second thing to author, and
  authors do not maintain metadata that nothing reads.
- **Raw storage, narrowed reads.** The stored value is what the manifest declared, so a typo
  (`group: sekurity`) or a member retired after the row was synced survives to the surface that can
  tell its author about it. Narrowing at write would destroy exactly the information needed to fix
  the manifest, and guessing a neighbouring member would put a playbook in front of the wrong step.
- **A trait, not a kind check.** Who applies a review queue is a property of the AGENT. A
  deployment that reviews through its own registered kind carries the trait and its reviewer
  receives the queue; a hard-coded `pr-reviewer` test would silently drop it. The trait is
  deliberately NOT on the code `reviewer` companion or a fixer: those run inside build pipelines,
  where the field is never set, so carrying it would state a reach they do not have.
- **The queue reuses the skill delivery rather than adding a step.** A queued lens is not a
  separate agent run: it is context the reviewer applies while slicing. Modelling it as extra steps
  would mean N container clones of the same pull request and N disjoint finding sets to merge,
  where the reviewer already owns aggregation and de-duplication.
- **Hard failure, not a silent skip.** A review that quietly dropped the security lens it was asked
  for reads exactly like a clean review, which is the failure mode "degrade loudly" exists to
  refuse. The cap exists for the same reason costs are counted elsewhere: each queued skill's
  instructions ride the reviewer's prompt for every turn of the review.

- **The resolver batches, because a queue is a list.** `SkillRunResolver.resolveManyForRun` is now
  the entry point (`resolveForRun` is its one-id case): one `accountOf`, one catalog read, one
  installation lookup, and one freshness probe per SOURCE for the whole list. A loop over the
  singular method would have paid each of those per queued skill, and the skill-catalog cache
  passes through on the Worker isolate profile, so those are real repeated D1 reads there rather
  than cache hits. Source rows read along the way are held in a map scoped to the CALL, never to
  the resolver: the Node facade builds its container once per process, so an instance-level map
  would be a standing cache of rows whose sync pins move under it.

## Consequences

- **Runtime symmetry.** One column, mirrored D1 (`0096_account_skill_group.sql`) ⇄ Drizzle, with
  the conformance round-trip asserting that a group this build does not know survives storage
  unchanged. Existing rows default to `other` and are rewritten from the manifest on the next sync
  of their source.
- **The public API does not carry the queue.** `BUILTIN_PUBLIC_TASK_FIELDS` states one static field
  table for every caller, and the valid ids here are the calling account's catalog. Advertising a
  vocabulary the descriptor cannot state is what the `targetPath` omission already refused. Adding
  it later, as its own discovery read, is additive.
- **ADR 0024's "skills are step-only" no longer holds**, and had already been widened once by ADR
  0029's kind-declared capabilities. There are now three sources for one dispatch's skills (kind,
  task, step); `run-skills.ts` owns their order, dedup and per-source failure policy in one place.
- **The queue is picked at creation and read-only afterwards.** The inspector shows what a review
  will apply; changing it is a task edit through the ordinary `taskTypeFields` patch. An editor on
  the review panel is the obvious follow-up, not a gap in the model.

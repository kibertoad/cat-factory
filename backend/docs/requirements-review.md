# Requirements review: the iterative product-layer loop

The FIRST step of the default pipelines, handled inline in the engine
(`RequirementReviewService`, orchestration `modules/requirements/`, table `requirement_reviews`).
The reviewer raises severity-tagged findings, the run parks, and the dedicated window drives an
iterative loop: answer/dismiss, then an incorporation companion folds the answers into ONE
document, then a re-review converges (`incorporated`), continues (`ready`), or hits the cap
(`exceeded`, where the human picks extra-round / proceed / stop-reset). Findings at or below
the merge preset's `maxRequirementConcernAllowed` tolerance auto-pass, and its
`maxRequirementIterations` is the cap above. Pass-through when the reviewer model isn't wired.

## The severity floor decides what is RAISED; the concern tolerance decides what STOPS

Two policy fields act on severity, at different points, and neither replaces the other.
`requirementFindingFloor` (default `medium`) is the lowest severity a pass raises at all;
`maxRequirementConcernAllowed` then decides whether the findings that were raised park the run.
Operator-facing account: the website's
[requirements guide](https://www.catfactory.ai/guide/requirements.html).

- **Both halves enforce it.** The reviewer's user prompt names the floor so it spends no effort
  below it, and `IterativeReviewService` drops whatever still comes back under it. Only the
  requirements kind is handed a floor (`review-kinds.ts`); clarity and brainstorm raise everything.
- **Progressive mode reads the block's estimate at the start of each pass**
  (`requirementFloorProgression`, resolved by `resolveRequirementFindingFloor` in contracts against
  the highest of complexity / risk / impact). The seeded pipelines run `requirements-review` before
  any `task-estimator`, so a first run usually has no estimate: the fixed floor applies and the pass
  records `basis: 'no_estimate'`, which the window states rather than letting the fallback read as a
  decision. Running an estimator inside the step was rejected: it costs a call per run, and the brief
  it would score is the vague one this review exists to fix.
- **Every pass records what it raised against** (`RequirementReview.findingFloor`: severity, basis,
  score, and how many findings it dropped), so a quiet review held to `high` never reads like a clean
  one. The review window shows it, and the `/api/v1` requirements decision carries it as
  `findingFloor`. The dropped count covers only what the model returned despite the prompt; what it never
  wrote cannot be counted, which is why the floor itself is shown too.

## Scope: the product / business layer ONLY

The technical layer belongs to the later `architect` and `researcher` steps, which have the repo
and `tech-spec/` in hand. A technical finding here asks a product owner something they cannot
answer and buries the questions only they can. The boundary is ONE shared
`PRODUCT_SCOPE_BOUNDARY` block folded into all THREE prompts of the flow
(`prompts/requirements.ts`) plus the user prompts in `requirements.logic.ts`, because it only
holds if every agent honours it. Editing any of them means bumping its number in
`kinds/versions.ts`.

## Every finding is in ONE of two groups, and the group decides who answers

The reviewer classifies each finding it raises (`autoAnswerable`), and the two groups are the review
window's primary structure rather than a badge on one edge case:

- **answerable from practice** — universal best practice, the idiomatic approach of a stack the work
  already uses, or the context already provided settles it. The Requirement Writer pre-answers these
  so a human is handed a mostly-filled review;
- **needs a product decision** — a business / product / domain call, a judgement somebody should own,
  or information the reviewer was not given.

An UNCLASSIFIED finding (a reviewer pass predating the flag, a garbled reply) is read as the second
group, by the contract, the engine and the window alike: the safe direction is the one that asks a
person. A false TRUE is the one mistake here nobody sees, which is why the prompt says so.

Each Writer suggestion additionally reports a `confidence` (0..1), which is a DIFFERENT claim from
`groundedIn`: that one says where the answer came from, this one how sure the Writer is of the answer.
A standard can settle a finding only partly and a general practice can be near-universal, so neither
predicts the other. Unreported stays null rather than defaulting, and a number outside the scale is
read as unreported rather than clamped.

## Headless callers drive the same loop

They act over `/api/v1/runs/:runId/decisions`, on the `decide` rung of the scope ladder
(`read ⊂ write ⊂ decide ⊂ admin`). **Do not add a park timeout: a parked run waits for a human
indefinitely by design.** The backstops are the workspace in-flight cap and
`POST /api/v1/jobs/:id/cancel`.

**A run nobody is watching may settle the FIRST group for itself**, and only it. Under
`autonomy: 'unattended'` the gate folds the answers in and carries on when every finding was
dismissed, resolved, answered by a person, or auto-answered by a suggestion at or above the policy's
`minAutoAnswerConfidence` (`reviewSettledForUnattended`); one finding in the second group, or one
graded below the floor, parks the whole review exactly as before. The step stamps
`autoAnsweredByPolicy` when it folded in, distinct from `reviewCapSettledByPolicy`: that one means the
loop gave up, this one that it converged on answers nobody read. Under `attended` nothing changes — a
suggestion there is a draft a person is about to read, so grading it changes nothing about who
decides. Design record: [ADR 0054](./adr/0054-per-scope-pipeline-defaults.md).

**The pipeline a headless run resolves is a separate lever, and usually the better one.** The seeded
unattended default (`pl_unattended`) runs no requirements conversation at all; a caller that wants one
names `pl_complex`.

## The platform must TELL the reviewer what system the work is about

An inline reviewer has no checkout. The context therefore carries the owning service (+ its
`spec/overview.md` intent), and an unresolved one is stated as `NOT STATED` rather than omitted: a
bare title identifies no software, and an omission reads like a task whose product is obvious, so
the model invents one and the next incorporation makes the invention authoritative. The
`NO_ASSUMED_PRODUCT` directive on every prompt in the flow is the other half; the renderer is
shared (`modules/review/product-context.ts`) because the rule only holds if the reviewer, the
dialogue and the incorporation editor all honour it.

## A derived subject NEVER displaces the requester's words

An incorporated document, a brainstormed direction and a clarified bug report are all rendered
ABOVE the original description, which stays in the prompt labelled as the original request.
Substituting it was how one pass's drift became permanent: the derived text is authoritative on
the next pass, so nothing downstream could still see what was asked for.

## Web search is WITHHELD when the system is unidentified

The Writer's provider-hosted web search is gated on `productIsIdentified`, because a
model-composed query about a guessed product comes back with real sources about unrelated
software: an invention that now reads as researched. Its `groundedIn` provenance (`standard` /
`project-spec` / `web` / `general-practice`) is reported per suggestion, and an unreported level
stays NULL rather than defaulting.

## Writing the refined requirements into the source issue

When the task came from a tracker issue (Jira, GitHub Issues, GitLab Issues, Linear, or a
deployment's own source), the refined document can replace that issue's description. Two triggers
share one path through `RefinedRequirementsPublisher` (orchestration):

- **The "Update linked issues" button** in the review window, always available once a document
  exists. It refuses with `refined_requirements_unavailable` while there is none or a fold is
  rewriting it, and with `no_linked_issues` when nothing is linked.
- **The `writebackRequirementsToDescription` workspace setting**, off by default. When it is on,
  the review gate's settle hook (`ReviewKind.onSettled`, requirements kind only) writes the approved
  document as the gate lets the run move on, on every path that settles it: an auto-pass, a
  converged re-review, an unattended cap settle, and a person proceeding. It never fires on an
  incorporation that still has findings.

`IssueWritebackService.writeRefinedRequirements` (integrations) fans out over the linked issues
through each source's optional `writeback.replaceDescription`; a source without it reports
`unsupported`. Every outcome is counted (`writeback.requirements_description`, by trigger and
outcome) and recorded on the review (`RequirementReview.issueWriteback`), which is what the window
lists per issue.

- **The description, replaced.** The description is what everyone reads, and every tracker keeps
  its history (Jira's history, GitHub's edit history, GitLab's description versions, Linear's
  history), so the reporter's words stay one click away. The rendered body opens with a line saying
  so.
- **Idempotent by content, with no marker.** Each adapter reads the stored description and writes
  only when it differs (`sameIssueDescription`; Jira compares through `adfToMarkdown`, so attributes
  Jira adds on save do not read as a change), answering `already_current` otherwise. A repeat, a
  replay of the gate step, or two clicks at once therefore write at most once and add no history
  entry. A replayed gate step records `already_current` over the first run's `updated`; the
  description holds the document either way.
- **Best-effort when automatic.** The settle hook runs through `runBestEffort` and is awaited before
  the run advances (so a Worker cannot drop it), and a tracker failure costs the writeback, never
  the run: the issue reports `failed` and the button retries it.
- **The outcome record is its own column.** `recordIssueWriteback` writes it in its own statement,
  outside `rev`, so neither it nor a concurrent review edit can clobber the other; `replaceForBlock`
  clears it with the review it replaces.
- **Converted mechanically, with no model.** GitHub, GitLab and Linear take the Markdown as it is;
  Jira's adapter converts it to ADF with `tracker/markdown-adf.logic.ts`. Jira caps a field at
  32,767 characters of stored ADF JSON, which outgrows the Markdown by a shape-dependent factor, so
  the conversion is cut to fit at a line and marked (`jiraFieldAdf`).

## Inline engine kinds and prompt overrides

These kinds run as bare inline `generateText` calls, so they bypass `systemPromptFor` and take
their prompts from `INLINE_ENGINE_SYSTEM_PROMPTS` as `{ role, directives }` pairs, composed per
call through `IterativeReviewService.systemPromptFor` so a per-workspace prompt override applies
to the role half only. Adding an inline engine kind means adding it there, SPLIT: one added with
its directives inside `role` runs fine and fails only later, as a workspace that edited it loses
its JSON output contract.

## Related

- The loop is driven end to end through the real window by
  [`requirements-review.spec.ts`](../internal/e2e/tests/requirements-review.spec.ts). Its three
  inline calls are scripted by prompt SHAPE (the e2e backend has no model), so a change to
  `buildReviewPrompt` / `buildReworkPrompt` can break that fake: see the seam's own drift guard in
  [`the e2e README`](../internal/e2e/README.md#inline-llm-calls-the-e2einlinemodels-seam).
- Prompt overrides and the role/directives split:
  [`agent-prompt-overrides.md`](./agent-prompt-overrides.md).
- The preset the knobs above live on: `RiskPolicySeed` in kernel's `domain/catalog.ts`. The
  merge policy it belongs to (auto-merge ceilings, `classRules`, who may land what): AGENTS.md,
  "Merge lifecycle".
- The precheck-first sibling: `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so
  the rework + re-review LLM calls are skipped when the human left nothing to fold in.

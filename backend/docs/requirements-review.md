# Requirements review: the iterative product-layer loop

The FIRST step of the default pipelines, handled inline in the engine
(`RequirementReviewService`, orchestration `modules/requirements/`, table `requirement_reviews`).
The reviewer raises severity-tagged findings, the run parks, and the dedicated window drives an
iterative loop: answer/dismiss, then an incorporation companion folds the answers into ONE
document, then a re-review converges (`incorporated`), continues (`ready`), or hits the cap
(`exceeded`, where the human picks extra-round / proceed / stop-reset). Findings at or below
`maxRequirementConcernAllowed` auto-pass; cap and tolerance live on the merge preset. Pass-through
when the reviewer model isn't wired.

## Scope: the product / business layer ONLY

The technical layer belongs to the later `architect` and `researcher` steps, which have the repo
and `tech-spec/` in hand. A technical finding here asks a product owner something they cannot
answer and buries the questions only they can. The boundary is ONE shared
`PRODUCT_SCOPE_BOUNDARY` block folded into all THREE prompts of the flow
(`prompts/requirements.ts`) plus the user prompts in `requirements.logic.ts`, because it only
holds if every agent honours it. Editing any of them means bumping its number in
`kinds/versions.ts`.

## Headless callers drive the same loop

They act over `/api/v1/runs/:runId/decisions`, on the `decide` rung of the scope ladder
(`read ⊂ write ⊂ decide ⊂ admin`). **Do not add a park timeout: a parked run waits for a human
indefinitely by design.** The backstops are the workspace in-flight cap and
`POST /api/v1/jobs/:id/cancel`.

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
- The merge preset that carries the cap and tolerance knobs: CLAUDE.md, "Merge lifecycle".
- The precheck-first sibling: `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so
  the rework + re-review LLM calls are skipped when the human left nothing to fold in.

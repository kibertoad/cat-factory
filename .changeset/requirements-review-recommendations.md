---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Improve the requirements-review experience.

**Auto-save answers (no button).** The requirements-review window no longer has a "Save
answer" button: an answer is seeded into its textarea from the recorded reply and persisted
on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

**"Recommend something" + the Requirement Writer.** A finding can now be marked for a
grounded recommendation instead of being answered or dismissed. A new second companion of
the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
`requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
precedence order: the block's **best-practice fragments** (team/org standards — checked
FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
(provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
folded into the next incorporation), rejects, or re-requests with a "do it differently"
note. Recommendations are a first-class collection on the review that survives the re-review
item churn.

- Contracts: `recommend_requested` item status, `RequirementRecommendation` +
  `recommendations[]` on `RequirementReview`, and the request schemas.
- Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
  (new D1 migration `0009` ⇄ Drizzle column + generated migration).
- Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
  `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
  + best-practice-fragment resolver deps (degrade gracefully when unwired).
- Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
  `…/recommendations/:recId/{accept,reject,re-request}` routes.

**Board progress for the review companions.** While the review is incorporating, re-reviewing
or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

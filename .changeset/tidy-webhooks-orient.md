---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Tell agents which system they are working on, and stop the platform standing in for it.

A neutral task ("implement webhooks") was coming back from requirements review as a design for the
orchestrator's own webhooks. The cause was structural rather than a bad prompt: no agent prompt named
the block's OWN service. A step's prompt carried the pipeline, the block, and every PEER service —
never the one the work belongs to. A container agent recovers that by reading its checkout; an inline
reviewer cannot, so a short title arrived with no identified subject, and a model asked for concrete
findings against an unidentified subject supplies one — commonly the most salient proper noun in the
prompt, which is the platform's own name.

`AgentRunContext.ownService` now carries the enclosing service frame, derived from the ancestry walk
the repo resolution already does. It is a discriminated result, not a nullable field, because the two
ways of having no service mean opposite things: a frame-level run has none because it IS one, while a
loose task has none because the platform does not know — and that case is now RENDERED, not omitted.
An omitted product reads exactly like an obvious one, which is what invited the invention.

Three follow-on breaks in the same chain:

- A derived subject no longer displaces the requester's words. An incorporated requirements document,
  a brainstormed direction and a clarified bug report are rendered ABOVE the original description
  instead of replacing it. Substitution is how one pass's drift became permanent — the derived text is
  authoritative on the next pass, so nothing downstream could still see what was asked for.
- The Requirement Writer's provider-hosted web search is withheld when the system is unidentified. A
  model-composed query about a guessed product returns real sources about unrelated software, which
  reads as diligence. Each suggestion now also reports what it rests on (`groundedIn`:
  team standard / project spec / web / general practice), surfaced in the review window.
- The inline review kinds honour per-workspace prompt overrides at last. They run as bare
  `generateText` calls, so they never reached `systemPromptFor` — the seam that applies an override —
  while the prompt editor happily accepted one and showed a baseline no code path sent. Their prompts
  are now `{ role, directives }` pairs like the bespoke container kinds, so an override replaces the
  role and cannot delete the JSON output contract or the scope rules.

Behaviour change to be aware of when reviewing: every built-in prompt gains one appended paragraph
(the platform is not the product), and the requirements / clarity / brainstorm prompts are reordered
into their two halves, so all nine are version-bumped. A workspace that had saved an override for one
of the inline kinds will find it takes effect on the next run, having previously done nothing.

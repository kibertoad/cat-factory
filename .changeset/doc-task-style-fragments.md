---
'@cat-factory/prompt-fragments': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': patch
---

Universal writing-style fragments for document-authoring tasks (WS2 of the
documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
(cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
the point, active voice, one idea per paragraph, every recommendation names an actor
and an action) — now guide the document-authoring agents.

They reach those agents through a new `doc-aware` capability trait, the document
analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
`doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
carries it too, so the execution engine folds the block's selected style fragments
into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
uses — no parallel fragment path in the prompt builders. Because the reviewer sees
the same bodies, the style guidance is both the writer's instruction and the
reviewer's criteria (an explicit clause in the companion prompt says so).

A new document task is pre-seeded with both style fragments (default-on,
user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
at task creation, not hard-coded in a prompt.

---
'@cat-factory/app': patch
---

UX papercuts (docs/initiatives/ux-papercuts.md): render agent prose as markdown and make
structured output copyable in the result-view surfaces (UX-43, UX-44 copy affordances).

- New shared `renderMarkdown()` reader (secure markdown-it, `html: false`, links decorated to
  open safely in a new tab) + a reusable `common/MarkdownProse.vue` component that renders it
  with the inspector's prose styling.
- The merger result view (rationale + pre-structured raw output), the consensus session window
  (synthesis + round contributions), and the generic structured result view (prose summary) now
  route their prose through `MarkdownProse` instead of a `whitespace-pre-wrap` plain-text dump,
  so `**bold**`, lists, code, and links read as formatted prose — consistent with
  `AgentStepDetail`'s reader.
- Copy affordances (the shared `common/CopyButton.vue`) added to the generic structured JSON
  block and to the consensus synthesis + each round contribution, so a user can lift the
  structured output without a manual select-all.

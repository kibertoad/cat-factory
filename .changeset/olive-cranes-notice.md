---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Break loudly when a task's referenced context documents cannot reach the agent.

A document attached to a block (or named by its description and resolved against the imported
corpus) is the intent the agent is meant to build against, but two paths dropped one on the floor:
a reference that resolved to a page with a blank body materialised a `.cat-context/` file holding a
title and a URL the agent cannot open, and a corpus over the ~256 KB materialised-context budget had
its overflow silently discarded. In both cases the run looked completely healthy while the agent
worked from a spec nobody noticed it never read.

Both now refuse, naming every reference that could not be delivered plus the remedy — re-import the
page, or detach it from the task — and carrying a machine-readable `details.reason`
(`context_document_unreadable` / `context_documents_over_budget`) so the run's failure record shows
the cause rather than only the prose. The invariant lives in kernel
(`domain/context-references.ts`) because the reference can vanish in two different layers and both
must refuse in the same words. Each refusal is asserted over the content its caller actually
renders: `hasReadableContent` where the raw body is delivered to a checkout, `contextExcerptFor`
where an inline caller can carry only a short excerpt (a body that is pure markup is something a
container agent at least opens, and projects to nothing for an inline reviewer).

**Compatibility break:** a run whose task attaches an empty page, or more than ~256 KB of context,
now fails instead of proceeding with less context than the board shows — the unreadable case on the
first step that resolves context (`requirements-review` on the default pipelines), the over-budget
case on the first container dispatch. That is the intended trade: the remedy is a human decision,
and it is named in the failure.

Both refusals now record the run failure as `preflight` rather than `agent`, since nothing ever
reached an agent. That also fixes the KIND for every other `DomainError` a driver catches out of
`advanceInstance` (a `github_not_connected` conflict, an unwired deploy runner), which used to be
filed as an agent failure and sent readers looking for a transcript that does not exist.

Two cases deliberately do NOT refuse. A URL that matches nothing imported is logged at `info`
instead: the providers' `parseRef` implementations are host-blind (`parseNotionRef` claims any
string carrying a UUID-shaped run; `parseConfluenceRef` any URL with a `/pages/<digits>` segment),
so a claim is evidence of a shape rather than of a reference, and refusing would block a task whose
description happens to link a dashboard. And a budget that omits an item from a PROMPT now states
the omission rather than failing: `renderLinkedContext` says how many materialised items the capped
index leaves unlisted (they are all on disk) and names the documents an inline, checkout-less
kind's injection had no budget left for, since an unmentioned omission reads as "this is the
complete set". Both notices are bounded, because a notice reporting a budget overrun must not be
able to cause one.

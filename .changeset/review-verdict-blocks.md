---
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
'@cat-factory/app': patch
---

Render a review verdict as blocks a human can skim, and ask the reviewer to write it that way.

A companion's verdict (the architect/spec/code/doc reviewers) arrives as ONE string: `comments`
only exist where the graded output has ids to anchor to, so everything the reviewer found lands in
`summary`. Unshaped, a model writes that as a single dense paragraph numbering its points inline
("(1) … (2) …"), and the run panel then appended it to the score inside the same line
(`78% < 80% — <four hundred words>`). Nothing about that is skimmable: a reader cannot tell what
blocks the work from what is a nit without reading all of it.

Both halves move. `REVIEW_SUMMARY_LAYOUT` (agents, `prompts/shared.ts`) asks for a fixed skeleton,
a one-line verdict then `**Must fix**` / `**Should fix**` / `**Minor**` bullet groups, and is
carried by every companion (built-in and deployment-registered, since they share one prompt) and
by every judge. The SPA renders those summaries through the existing `MarkdownProse` reader
instead of plain-text dumps, and each companion round is now its own card rather than a
continuation of the score line. The same render fix reaches the reviewer prose the first markdown
sweep missed: judge summary and findings, best-practice adherence, the PR-review summary,
findings, suggested fixes and challenge verdicts, and the tester report.

Kernel's `extractJson` now repairs raw control characters inside a JSON string literal. A
multi-line summary is exactly what makes a model forget the `\n` escape, and refusing that reply
costs the whole verdict (a companion that returns nothing parseable fails the run) over a quoting
slip. The judge prompt bumps to `judge@v2`; scoring is untouched, but what it writes changed.

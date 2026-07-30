---
'@cat-factory/app': patch
---

Let the review/reading overlays take the whole screen instead of floating in a 1024px card.

`ResultWindowShell`'s width buckets (`3xl|4xl|5xl`) were transcribed one-for-one from each window's
pre-shell `max-w-*` during the slice-5 conversion, so nothing ever re-examined them against what the
windows actually became. The initiative plan review is the clearest case: it grew a three-column
layout — outline sidebar, the plan as a document, the review rail — and then had to fit all three
inside 1024px, leaving the plan itself about 490px wide while the two thirds of a wide display either
side of the window sat empty.

The bucket vocabulary gains **`full`**: the panel spans the viewport minus the shell's existing
gutter, which is the shape the full-bleed step reader (`AgentStepDetail`) has had all along — so this
is adopting a house pattern rather than inventing a wider modal. It is not the new default. `full` is
for a window whose body lays out in COLUMNS, where the width buys visible layout; a short verdict or a
single column of prose keeps its bucket, because stretching two paragraphs across an ultrawide reads
worse, not better. On that line: the plan review + tracker, requirements review, clarity review,
brainstorm, PR review, tester report and service spec.

**What the extra width may NOT be spent on is line length.** Continuous prose inside a `full` window
now carries its own reading measure (`max-w-3xl`, the step reader's, over the same 13px
`.reader-prose` sheet), and the leftover is the document's margins. Deliberately only prose: a
findings list, a requirements table, a Gherkin block and a log tail all read better at the full span,
and capping those would spend the width back on gutters. That split is why the plan document is capped
while the finding cards beside it in the requirements and clarity windows are not — a finding is a
short question next to its answer control, where wide means fewer rows to scroll.

`PrReviewWindow` gains the most: it was still on `3xl`, the narrowest bucket, for a surface listing
per-file findings with paths, line numbers, suggested fixes and investigator justifications.

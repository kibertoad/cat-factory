---
'@cat-factory/app': minor
---

A failed run shows one failure block per task view: a title, a one-line cause, one action, and a
Details toggle. The cause line is translated SPA copy keyed by the failure's `kind` and `reason`,
and it says if a retry will probably work. The action is Retry, or the setting that fixes the
cause (connect a repository host, set up environments or the runner pool), with Retry then inside
Details. The backend's message, its per-kind hint and the full output are inside Details only.
The board card and the queue card show the title and the action only. The inspector no longer
repeats the block in its header for a task or an initiative, the focus view now shows it under
the run's summary, and the lists of earlier failures show the cause line with the rest behind
Details.

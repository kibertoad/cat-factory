---
'@cat-factory/app': minor
---

A failed run shows one failure block per task view: a title, a one-line cause, one action, and a
Details toggle. The cause line is translated SPA copy keyed by the failure's `kind` and `reason`,
and it says if a retry will probably work. The action is Retry, the setting a refusal names
(the same copy and fix as its toast: connect a repository host, configure AI, configure storage,
set up the runner pool), or a new run of the failed run's pipeline when the run's saved state
cannot be read; Retry is then inside Details. An environment failure leads with Retry and shows
the environment setup beside it. A single-job run (a service bootstrap, an environment config
repair) has its own cause lines where a kind means something different. The backend's message, its per-kind hint and the full output are inside Details only.
The board card and the queue card show the title and the action only. The "Read a failure" tour
follows the block's one action. The inspector no longer
repeats the block in its header for a task or an initiative, the focus view now shows it under
the run's summary, and the lists of earlier failures show the cause line with the rest behind
Details.

---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Put the salvage in front of the pre-PR gates, keep its account of itself honest, and stop
declaring a tool set to a CLI this image does not pin.

The salvage ran last, after the reproduction proof and the pre-PR validation loop. Both are gated
on whether the branch carries commits, so a run whose entire product was uncommitted new files
(the greenfield case the salvage exists for) skipped validation altogether and then opened a pull
request with no validation report at all: "only a green checkout opens a PR" held for every run
except the ones being rescued. It now commits ahead of both, with a second mop-up pass folded onto
the first so a repair round's own new files are still recovered.

Three smaller corrections around it. A settle-path salvage told a human "this run was aborted",
describing a failure that had not happened, because only the commit message took the occasion. A
single-repo pull request built entirely out of salvage carried nothing saying so, though the
multi-repo path had marked its legs for a while. And `commitPaths` committed the whole index
rather than the paths it was given, so an agent killed with work staged had that work landed under
a message naming other files, counted by a report that had never seen it; the abort rescue now
commits tracked edits under the run's own message first.

Separately, `--tools` is withheld from an `ambientAuth` run. The declared set is deliberately
over-inclusive because a tool NAME the build lacks is dropped silently, but that reasoning does not
extend to the FLAG carrying it: on a developer's own machine the harness knows neither which
`claude` is on the PATH nor how old it is, and an unrecognised flag fails the run outright.

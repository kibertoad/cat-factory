---
'@cat-factory/agents': minor
'@cat-factory/server': minor
---

Stop telling agents things that are not true of the run they are on.

Four findings the platform's own Kaizen graders filed repeatedly, all of them the same shape: a
prompt asserting a fact about the dispatch that the dispatch did not deliver.

- The best-practice-standards imperative ("treat every standard appended below as a hard
  requirement") was the closing line of seven prompt files, while the fold appends nothing when a
  block resolved no standards. It now belongs to the standards section itself, so the pointer and
  its target arrive together or not at all. The reviewer companion's adherence guidance was the
  same dangling pointer worded the other way round ("folded into this prompt above"); it is a JSON
  output contract rather than a standards header, so it could not move into the fold and is instead
  worded to be true whether or not anything was folded. `build` bumps to v7 and `review` to v3.
- The read-only guardrail forbade creating files while the effort-report guidance, appended to every
  container dispatch, ordered one written "after any commit/push" on a step forbidden to commit. The
  guardrail now names `.cat-effort.json` as its one permitted write and states that no commit
  happens; the effort report no longer times itself off a commit.
- Container agents are now told what the execution sandbox can and cannot do: no Kubernetes tooling
  or cluster/registry credentials, a Docker daemon that must be probed rather than assumed, and
  toolchain versions that are the image's rather than the target's. Above all, that an artifact this
  sandbox cannot execute is still a correct artifact, reported in one line.
- A companion round whose rating cleared the bar but which a `blocker` held back rendered to the
  next round as "did not meet the bar", asserting a comparison the engine never made. The bar
  comparison and the disposition are now two facts, with the reason named when they disagree.

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
  carve-out naming `.cat-effort.json` as the one permitted write now rides the effort report, which
  is the half of the pair that reaches every container kind: a carve-out in the guardrail could not
  reach `merger` or `on-call`, whose prompts bypass `systemPromptFor`, and would have promised a
  working directory to the inline consensus participants that share that seam. The guardrail states
  only what the agent may do, since a read-only step's output can still be committed by a backend
  post-op (`spike`).
- Container agents are now told what the execution environment can and cannot do: no cluster or
  registry credentials from the platform, every tool probed rather than assumed, and toolchain
  versions that are the environment's rather than the target's. Above all, that an artifact this
  environment cannot execute is not incomplete for that reason, reported in one line. It names no
  environment, because the same job body serves both the harness image and the local native
  transport, and it stops short of calling an unverifiable artifact correct: the same paragraph
  reaches the reviewers.
- A companion round whose rating cleared the bar but which a `blocker` held back rendered to the
  next round as "did not meet the bar", asserting a comparison the engine never made. The bar
  comparison and the disposition are now two facts, with the reason named when they disagree, in
  both directions: a round advanced on a rating below the threshold no longer reads as having met
  it either.
- The prompt editor's "what the platform appends to whatever you save" is measured from the wire
  rather than from one seam. The sandbox contract and the effort report are appended after
  `systemPromptFor` has run, so a workspace editing a `coder` prompt was shown a directive list
  ~2.3 KB shorter than the dispatch sends. They are now declared as one ordered pair
  (`CONTAINER_DISPATCH_DIRECTIVES`) that both the dispatch and the measurement read.

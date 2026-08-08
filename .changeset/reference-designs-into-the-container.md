---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
---

Hand a run's reference designs to the container that captures against them.

`.cat-context/reference-screenshots/` has been in the UI-tester prompt since the visual-confirmation
gate landed, and nothing wrote it. So a designer whose task links a Figma frame got a gate gallery
built from that frame while the tester itself worked blind, naming views of its own that then had to
be matched to design frames named by somebody else.

A dispatch of a kind declaring the `ui` image now resolves the task's reference set (its designs'
retained frames plus the images a person uploaded against it) and the harness downloads them into the
checkout before the agent's first turn, with each file's view name stated in the prompt.

The bytes do not ride the job body. A design frame is a full-page PNG and a job body is JSON that
crosses every transport and is persisted with the dispatch, so only a manifest of ids and file names
travels; the harness fetches the images from a new `GET ${proxyBaseUrl}/artifacts/reference/:id` on
the same container session token the run already holds for the LLM proxy. That route is the mirror of
the screenshot ingest route beside it and is bounded the same way, plus one more: it serves
`kind:'reference'` only, so it cannot become a way for one container to read another run's captures.

Two things a reviewer should look at. The reference SET now has two readers (the gate and a dispatch)
and therefore one module: derived twice, the two would eventually disagree about a view name, which
is exactly the join the gate performs. And the FILE NAMES are chosen by the engine, not the harness,
because the name is how the agent learns the view name: a sanitiser change in an image a deployment
has not rolled out yet would otherwise rename every view a run reports.

Runner image bump: harness `src/**` changed, so deployments must move to the newly pinned tag. A
deployment on an older image simply receives no references, exactly as before this change.

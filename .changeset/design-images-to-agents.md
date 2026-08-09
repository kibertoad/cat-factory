---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Show a task's design PICTURES to the agents that build the screen.

The frames an import retains for a linked design (Figma, Zeplin) already fed the
visual-confirmation gate and the UI tester's capture set. They now also reach the kinds that build
or plan a screen, on the two channels a dispatch can actually carry an image over: written into
`.cat-context/design-renders/` for a harness whose CLI reads image files, and attached to the model
request as image parts for an inline call. Which kinds get them is a declared trait
(`design-images`, on `coder` / `architect` / `fixer`), so a deployment's own UI kind opts in the
same way.

Delivery joins two DECLARED facts, and neither is inferred: `HARNESS_IMAGE_INPUT` says which agent
CLI can get bytes into a turn (`claude-code`; Codex and Pi are `false` with their reason stated),
and the new per-flavour `ModelRef.acceptsImages` says which model takes one. A dispatch that cannot
show the pictures TELLS the agent they exist, with which of the two is missing, so the textual
design description never reads as everything the platform had. An UNDECLARED model modality is its
own refusal reason rather than a silent "no", so an undeclared multimodal model cannot read as a
text-only one forever.

**Runner image bump** (`cat-factory-executor:1.107.0`): the harness gained the download for the new
manifest, and `designImages` joins `HARNESS_BODY_CAPABILITIES`, so a deployment running an older
image is told rather than leaving the backend's prompt naming a directory nothing wrote. Mirror the
tag into your registry and roll it out; nothing else in the change requires it.

Recorded prompt bodies now pass through `redactImagePayloads` on both the inline and proxy paths: a
`Uint8Array` JSON-stringifies to one entry per byte, so an attached frame would otherwise have
landed in telemetry as megabytes per recorded call.

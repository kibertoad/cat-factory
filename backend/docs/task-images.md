# Images attached to a task

A person can attach up to `MAX_TASK_IMAGES` images (`@cat-factory/contracts`, six today) to a task,
in the add-task form or later from the inspector: a bug screenshot, a sketch, a diagram. The agents
working the task are shown them as real image input wherever their model path can carry an image,
and are told when it cannot.

## Storage

An attached image is a binary artifact of kind `context`, anchored on the task's block, in the
account's binary-artifact store (`BinaryArtifactStore`, the same seam as screenshots and reference
designs). No new table or port: the SPA uploads through `POST /workspaces/:ws/artifacts` with
`kind=context`, lists through `GET /workspaces/:ws/blocks/:blockId/artifacts` and removes through
`DELETE /workspaces/:ws/artifacts/:id`, which only ever deletes `reference` and `context` rows.

- `context` is in `RETAINED_BINARY_ARTIFACT_KINDS`: the age sweep never takes it, because it is part
  of the task's definition rather than run debris.
- A block delete reclaims every artifact anchored on the doomed subtree (`pruneByBlocks`, one batched
  `listByBlocks` read), best-effort after the rows are gone.
- A `context` image is never a reference: the visual-confirmation gate and the tester's capture set
  read `reference` rows only.

## Delivery

Kinds carrying the `task-images` trait resolve the set at dispatch (`run-images.ts`, from the same
block listing the design pictures use). The prompt section (`taskImagesSection`, appended once in
`userPromptFor`, so every kind states it) renders from the set plus a per-dispatch verdict, the
`DesignImageDelivery` vocabulary the design pictures already use:

| Path                                           | How the images travel                                              | Refused when                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Inline agent step (`AiAgentExecutor`)          | image parts on the user message                                    | model declares no image input, or the ambient text-only inline path   |
| Requirements, clarity and brainstorm reviewers | image parts on the reviewer and rework calls                       | same rule (`reviewTaskImages.ts`)                                     |
| Container step                                 | `taskImages` manifest, downloaded into `.cat-context/task-images/` | the harness CLI cannot read an image (Pi, Codex), or the model cannot |
| Consensus panel                                | none                                                               | always: `consensus_panel`                                             |
| Delegated executor                             | none                                                               | always: `delegated_brief`                                             |

`taskImages` is a harness body capability (`HARNESS_BODY_CAPABILITIES`), so an image too old to parse
it refuses the step rather than running with a prompt that names files nothing wrote.

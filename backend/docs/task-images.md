# Images attached to a task

A person can attach up to `MAX_TASK_IMAGES` images (`@cat-factory/contracts`, six today) to a task,
in the add-task form or later from the inspector: a bug screenshot, a sketch, a diagram. The agents
working the task are shown them as real image input wherever their model path can carry an image,
and are told when it cannot.

## Storage

An attached image is a binary artifact of kind `context`, anchored on the task's block, in the
account's binary-artifact store (`BinaryArtifactStore`, the same seam as screenshots and reference
designs). No new table: the SPA uploads through `POST /workspaces/:ws/artifacts` with
`kind=context`, and lists, serves and removes through the task:
`GET /workspaces/:ws/blocks/:blockId/images`, `GET .../images/:id/blob` and
`DELETE .../images/:id` (`taskImageRoutes.ts`).

- **It lives at the workspace that HOMES the task**, never the board in the URL. A task under a
  shared service is one row seen from every board mounting it, its runs execute at its home, and its
  block delete reclaims there, so every route resolves the home first through
  `BoardService.resolveBlockHome` (the board-mutation rule: a board that neither homes the task nor
  mounts its service gets a 404). The block must be a `task`; anything else is refused with
  `task_image_block_not_task`, since a frame's image would be retained with no reader.
- `context` is in `RETAINED_BINARY_ARTIFACT_KINDS`: the age sweep never takes it for its age, because
  it is part of the task's definition rather than run debris.
- Every path that removes or moves a block carries its images (`board/blockArtifacts.ts`): a block
  delete and a recurring schedule's removal reclaim them (`pruneByBlocks`) after the rows go, and a
  cross-home reparent re-keys them to the destination home (`moveBlocks`) while the subtree exists
  at both homes. Both are best-effort.
- What those leave behind is the age sweep's: `context` is in
  `BLOCK_ANCHORED_BINARY_ARTIFACT_KINDS`, so each sweep lists the blocks carrying an aged image
  (`listBlockAnchorsOlderThan`, one `DISTINCT` read), resolves them in one `findByIds`, and reclaims
  the rows whose block no longer exists in their workspace. That covers a blob delete that failed, a
  best-effort reclaim that never ran, and a delete path that does not call it.
- A `context` image is never a reference: the visual-confirmation gate and the tester's capture set
  read `reference` rows only.

## Delivery

Kinds carrying the `task-images` trait resolve the set at dispatch (`run-images.ts`, from the same
block listing the design pictures use). A kind that wants ONLY the attached images (the reviewing
kinds) lists them off the metadata (`CoreDependencies.binaryArtifactIndex`) without resolving the
account's store, so a task with no image costs one indexed read. An inline call resolves the store
at most once for its listing and every byte read (`inlineImageStore`), and a byte read that fails
withholds that picture and settles as `transfer_failed` rather than failing the call.

The prompt section (`taskImagesSection`, appended once in `userPromptFor`, so every kind states it)
renders from the set plus a per-dispatch verdict, the `DesignImageDelivery` vocabulary the design
pictures already use:

| Path                                           | How the images travel                                              | Refused when                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Inline agent step (`AiAgentExecutor`)          | image parts on the user message                                    | model declares no image input, or the ambient text-only inline path   |
| Requirements, clarity and brainstorm reviewers | image parts on the reviewer and rework calls                       | same rule (`reviewTaskImages.ts`)                                     |
| Container step                                 | `taskImages` manifest, downloaded into `.cat-context/task-images/` | the harness CLI cannot read an image (Pi, Codex), or the model cannot |
| Consensus panel                                | none                                                               | always: `consensus_panel`                                             |
| Delegated executor                             | none                                                               | always: `delegated_brief`                                             |

`taskImages` is a harness body capability (`HARNESS_BODY_CAPABILITIES`), so an image too old to parse
it refuses the step rather than running with a prompt that names files nothing wrote.

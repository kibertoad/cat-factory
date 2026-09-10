# @cat-factory/workspaces

## 0.29.6

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/contracts@0.353.0
  - @cat-factory/kernel@0.346.1

## 0.29.5

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0

## 0.29.4

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0

## 0.29.3

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0

## 0.29.2

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/kernel@0.343.1

## 0.29.1

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0

## 0.29.0

### Minor Changes

- 6ff632f: Add the in-app assistant: type what you want done, and the platform does it
  
  Everything on the board is reachable, and reaching it means knowing which panel holds it. Putting a
  repository on the board is a modal behind a sidebar entry; filing a task from a ticket is a second
  modal plus a source picker plus a container picker; declaring that one service depends on another is
  a field in a frame's inspector most people never open. Each is several clicks from someone who
  already knows the sentence they would say.
  
  The assistant takes the sentence. It ships with three actions, the ones a request most often is:
  declare that one service depends on another (so both are spun up when either is tested), add a
  service backed by a GitHub or GitLab repository named by its URL, and file a board task from an issue
  URL (GitHub, GitLab, Jira, Linear).
  
  The design decision worth reviewing is that the model does not act. It reads the request, names one
  action from a closed catalog and copies that action's arguments out of the words in front of it;
  everything after that is deterministic. The platform looks the id up in the catalog it rendered,
  validates the arguments through the shared descriptor validator, resolves every name against the
  board itself, and performs the action through the same service the equivalent button calls. So a
  hallucinated action id is a decline, an invented argument key is a dropped key, and a service name
  matching nothing (or matching two) is a question with the candidates attached. Nothing the model
  writes reaches a side effect, a stored row, or the screen.
  
  That last part is also why a turn answers with DATA rather than a chat message: the outcome variant
  carries the ids and titles of what was touched, or the machine-readable reason it could not act, and
  every sentence a person reads is rendered by the SPA from the i18n catalog. Putting the model's own
  explanation on the wire would have made the surface untranslatable and put unreviewed model text on
  screen.
  
  A QUESTION is answered as data too. A turn that could not resolve an argument carries the action it
  was heading for and the arguments it did resolve, so clicking one of the candidates re-runs that
  action with the chosen value in the field the platform named: no model call, nothing billed, and no
  chance of the answer routing somewhere else. The rule that comes with it binds any action added
  later: a candidate has to be a legal VALUE for the field the question names, or the person is being
  offered an answer the next turn refuses.
  
  `BoardService.addServiceFromRepo` now answers with the frame AND the disposition that produced it
  (`created` or `mounted`), an internal signature change with no wire effect. The account-wide dedupe
  answers with a frame either way, and only the operation knows which path it took: a caller comparing
  the returned frame against the board it read a moment ago sees a service homed on another board as a
  fresh import, which is the one case the distinction exists to report.
  
  Two alternatives were considered and rejected. A TOOL-CALLING loop (let the model call the board's
  own methods) would have put the model inside the write path, where a wrong argument is a wrong write
  rather than a wrong question, and would have made "which service did you mean?" unanswerable without
  a second round trip. A DEPLOYMENT-REGISTERED action catalog was left for a later step: every action
  performs a board write through an engine-internal service, the same reading that keeps the `merger`
  step resolver a privileged built-in, so opening the catalog means defining a public, minimal action
  context first. The tracker holds it as a named phase.
  
  Worth watching when reviewing:
  
  - The assistant is member tier and mounts no permission gate, on the same reading as the bug hunt:
    every action it performs is board authoring a member can already do from a button. Each write
    carries the asker's own tier (`blockEditAuthority`), so it is never a way around a policy its user
    is held to.
  - A turn is a billable model call no run start gates, so it answers to the workspace budget
    (`isOverBudget`) before any vendor is reached, and fails closed.
  - `WorkspaceService.snapshot` was refactored (no behaviour change) so that its board composition and
    the two visibility passes are one private method, and a new `boardBlocks` read shares them. That
    keeps exactly one definition of what is on a board while letting a caller that needs only the
    frames skip the workspace's pipelines, executions and three built-in catalogs.
  - There is no conformance group, and the reason is in the doc rather than an omission: the module is
    composed in `createCore` from dependencies every facade already provides, with no port
    implementation, table, migration or cron of its own. Making an end-to-end turn assertable per
    facade needs an `AssistantRouter` seam first, which is on the tracker.

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/kernel@0.342.1

## 0.28.64

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0

## 0.28.63

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0

## 0.28.62

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0

## 0.28.61

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0

## 0.28.60

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0

## 0.28.59

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0

## 0.28.58

### Patch Changes

- 5c50d30: Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
  wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
  from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
  folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
  per-row busy guard), and removes tests that asserted a constant against its own literal or
  re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.
  
  Internal-surface break, flagged per the compatibility rules: the removed barrel exports
  (`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
  `SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
  the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
  schema aliases) had no consumer in this repository; a downstream import of one of them fails at
  typecheck and should read the underlying helper directly.
- Updated dependencies [5c50d30]
  - @cat-factory/contracts@0.346.2
  - @cat-factory/kernel@0.336.1

## 0.28.57

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/kernel@0.336.0

## 0.28.56

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 0.28.55

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 0.28.54

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 0.28.53

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 0.28.52

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 0.28.51

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.28.50

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 0.28.49

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.28.48

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.28.47

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.28.46

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 0.28.45

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.28.44

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 0.28.43

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.28.42

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

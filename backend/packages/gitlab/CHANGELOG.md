# @cat-factory/gitlab

## 0.23.13

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/contracts@0.354.0
  - @cat-factory/kernel@0.346.2

## 0.23.12

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/contracts@0.353.0
  - @cat-factory/kernel@0.346.1

## 0.23.11

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0

## 0.23.10

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0

## 0.23.9

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0

## 0.23.8

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/kernel@0.343.1

## 0.23.7

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0

## 0.23.6

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/kernel@0.342.1

## 0.23.5

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0

## 0.23.4

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0

## 0.23.3

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0

## 0.23.2

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0

## 0.23.1

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0

## 0.23.0

### Minor Changes

- 76e2c1d: Bug-fishing expeditions now partition a large codebase into TERRITORIES and fish each angle over
  each one, instead of telling every pass to decide for itself where an angle could bite.
  
  The partition is computed by the platform from the repository tree (blueprint modules first, then
  package and directory boundaries, sized by blob bytes), the expedition stays ONE run whose phase
  list is territory x angle, each pass is handed its territory's manifest as a `.cat-context/` file
  so it starts from a map rather than three greps, and what each pass reported reading becomes a
  per-phase coverage record. A pass budget bounds the matrix and every cell it cuts is recorded as
  unfished. A codebase small enough to fish whole runs exactly as before.
  
  Territories are computed and stated in the frame the AGENT works in: the service's own directory
  in a monorepo, which is where the harness roots its checkout, rather than the repository root.
  
  A task-type field descriptor gains `integer`, so a `number` field whose value must be whole says so
  where a caller can read it instead of being refused at creation with a raw schema error. The public
  API spec moves to 1.70.0 for it; `review.prNumber` and the new `bug-fishing.fishingMaxPasses` both
  declare it.
  
  Internal wire break: `GitHubClient.listTree` and `VcsClient.listTree` now return
  `{ entries, truncated }` rather than a bare array, so a caller building a manifest can tell a
  truncated tree from a complete one. `bug-fisher` switches to `standardsDelivery: 'context-files'`,
  so its standards are read once from `.cat-context/` instead of re-sent on every turn of every
  pass.

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0

## 0.22.36

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

## 0.22.35

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/kernel@0.336.0

## 0.22.34

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 0.22.33

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 0.22.32

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 0.22.31

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 0.22.30

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 0.22.29

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.22.28

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 0.22.27

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.22.26

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.22.25

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.22.24

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 0.22.23

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.22.22

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 0.22.21

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.22.20

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

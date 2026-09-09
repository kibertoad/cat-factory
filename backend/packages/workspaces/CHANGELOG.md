# @cat-factory/workspaces

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

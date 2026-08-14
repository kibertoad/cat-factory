# @cat-factory/acceptance-kit

## 0.2.3

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.2.2

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.2.1

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/sdk@0.43.0

## 0.2.0

### Minor Changes

- f887604: Add `@cat-factory/acceptance-kit`: the building blocks for writing a headless acceptance suite
  against a live deployment (scenario driver, resumable ledger, progress journal, prerequisite gate
  with rendered remedies, waits that state their last observation, the SDK-driven run driver and the
  verification-report reductions), extracted from the platform's own acceptance suite so a deployment
  can cover its own providers, agent kinds and gates the same way.

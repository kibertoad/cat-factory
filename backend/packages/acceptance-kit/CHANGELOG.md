# @cat-factory/acceptance-kit

## 0.2.0

### Minor Changes

- f887604: Add `@cat-factory/acceptance-kit`: the building blocks for writing a headless acceptance suite
  against a live deployment (scenario driver, resumable ledger, progress journal, prerequisite gate
  with rendered remedies, waits that state their last observation, the SDK-driven run driver and the
  verification-report reductions), extracted from the platform's own acceptance suite so a deployment
  can cover its own providers, agent kinds and gates the same way.

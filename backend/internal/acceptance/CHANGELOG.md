# @cat-factory/acceptance

## 0.4.80

### Patch Changes

- 9f8cabc: Re-point the DeepSeek Flash route at the model DeepSeek actually serves, take the agent CLIs at
  their newest, and refresh the dependency tree.
  
  **A retired model behind a live alias.** DeepSeek retired V4-Flash and V4-Flash-Vision-Exp on
  2026-09-10 and made `deepseek-flash` the canonical, unversioned name for V4.1-Flash. The old
  `deepseek-v4-flash` id still resolves, but only as a TEMPORARY compatibility alias onto the new
  model, which is the quietest shape this catalog's failures take: nothing throws and nothing fails
  to dispatch, so the picker went on saying "DeepSeek V4 Flash" while a different model answered, at
  a rate the spend table did not carry, and the route dies outright whenever the alias is withdrawn.
  All three DeepSeek-served arms of the `deepseek` entry (direct, subscription, and the OpenRouter
  one, which must name the same model or the entry straddles two) now name the live model. The entry
  keeps its `deepseek` id: that id is what a workspace persists against a block, and this is the same
  slot following the vendor's own successor, so re-minting it would invalidate every stored pick to
  say nothing new. `acceptsImages` is new on both refs and is a real capability gain rather than a
  correction, since V4.1-Flash folds the vision line back into the main model.
  
  Two adjacent claims were re-read rather than trusted. The 2026-09-10 release note said
  `deepseek-v4-pro` would route to V4.1-Flash from 2026-09-14, which would have silently demoted that
  entry to a cheaper, weaker model; DeepSeek has since decided to keep serving V4 Pro with billing
  unchanged, so it is untouched. And OpenRouter still serves a separate `deepseek/deepseek-v4-flash`
  at a fifth of the price, which this entry deliberately does not keep: it is the retired build, and
  an entry whose direct and gateway arms named different models is the neighbouring-version trap the
  catalog header bans. Both retired price keys stay in the table so historical spend rows keep
  costing correctly.
  
  **No other catalog gap.** Every frontier launch since the last sweep was checked against its
  serving provider and is already here: Claude Fable 5.1, Gemini 3.8 Flash, Muse Spark 1.3 and GPT-6
  Astra. Claude Mythos 5.1 stays out on purpose. It is the same model as Fable 5.1 at identical
  pricing, offered by invitation only through Project Glasswing with no public route on any provider
  this platform reaches, so an entry could only be a re-badge that `effectiveVariant` would pick and
  then fail to dispatch. "Astra Pro" stays out for the reason recorded last time, re-checked here:
  OpenRouter mints a slug for it, but reasoning effort is a parameter on the single `gpt-6-astra` id.
  
  **Agent CLIs at their newest**, ahead of the 24h `minimumReleaseAge` window, as the Dockerfile's
  standing note allows for those three pins alone: Claude Code 2.1.265 to 2.1.270 and Codex 0.153.4
  to 0.154.0 (still above the 0.153.0 floor `gpt-6-astra` needs). Pi holds at 0.85.1, already newest.
  The two Pi extensions do NOT take that exemption and hold at 2.9.0: 2.10.0 published three hours
  before this change and has not aged past the window. Both harness images move to the newest
  `node:26-trixie-slim` digest that has (node 26.8.2), and the executor image tag rolls to 1.158.0
  with the deploy image at 0.6.8.
  
  **Dependency refresh**: direct ranges plus a lockfile re-resolution, 31 resolved names moved, no
  package name dropped. `pg-boss` 12.31.0 brings `rrule-temporal` and `temporal-spec` in as new
  transitive deps, the only additions. A `pnpm dedupe` follows the bump because the partial
  re-resolution left `@types/node` resolved at two patch versions. Four holds are unchanged and were
  re-verified at HEAD rather than assumed: `vitest` at 4.1.11 and `wrangler` at 4.124.0
  (`@cloudflare/vitest-pool-workers` 0.22.0 is still newest, peers `vitest: ^4.1.0` and pins that
  wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date, which
  that pool pins), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 reaches for
  `typescript/lib/tsc`, absent from TS 7's exports map). pnpm moves 11.24.0 to 11.26.0, staying on
  its major. WireMock holds at 3.13.1, still its newest non-prerelease. Actions: `setup-java` v6.0.0
  to v6.0.1 and `zizmor-action` v0.6.3 to v0.6.4; every other pinned action is already newest.
- Updated dependencies [9f8cabc]
  - @cat-factory/acceptance-kit@0.7.21
  - @cat-factory/cli@0.14.2
  - @cat-factory/contracts@0.355.1
  - @cat-factory/kernel@0.348.0
  - @cat-factory/sdk@0.54.1

## 0.4.79

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/contracts@0.355.0
  - @cat-factory/kernel@0.347.0
  - @cat-factory/sdk@0.54.0
  - @cat-factory/acceptance-kit@0.7.20
  - @cat-factory/cli@0.14.1

## 0.4.78

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/contracts@0.354.0
  - @cat-factory/sdk@0.53.0
  - @cat-factory/acceptance-kit@0.7.19
  - @cat-factory/cli@0.14.1
  - @cat-factory/kernel@0.346.2

## 0.4.77

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/contracts@0.353.0
  - @cat-factory/sdk@0.52.0
  - @cat-factory/acceptance-kit@0.7.18
  - @cat-factory/cli@0.14.1
  - @cat-factory/kernel@0.346.1

## 0.4.76

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0
  - @cat-factory/acceptance-kit@0.7.17
  - @cat-factory/cli@0.14.1

## 0.4.75

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/contracts@0.352.0
  - @cat-factory/kernel@0.345.0
  - @cat-factory/acceptance-kit@0.7.16
  - @cat-factory/cli@0.14.1
  - @cat-factory/sdk@0.51.3

## 0.4.74

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0
  - @cat-factory/acceptance-kit@0.7.15
  - @cat-factory/cli@0.14.1

## 0.4.73

### Patch Changes

- Updated dependencies [afd09af]
  - @cat-factory/contracts@0.351.1
  - @cat-factory/acceptance-kit@0.7.14
  - @cat-factory/cli@0.14.1
  - @cat-factory/kernel@0.343.1
  - @cat-factory/sdk@0.51.3

## 0.4.72

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/contracts@0.351.0
  - @cat-factory/kernel@0.343.0
  - @cat-factory/acceptance-kit@0.7.13
  - @cat-factory/cli@0.14.1
  - @cat-factory/sdk@0.51.3

## 0.4.71

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/contracts@0.350.0
  - @cat-factory/acceptance-kit@0.7.12
  - @cat-factory/cli@0.14.1
  - @cat-factory/kernel@0.342.1
  - @cat-factory/sdk@0.51.3

## 0.4.70

### Patch Changes

- Updated dependencies [ca5be97]
- Updated dependencies [333b967]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/acceptance-kit@0.7.11
  - @cat-factory/cli@0.14.1
  - @cat-factory/sdk@0.51.3

## 0.4.69

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0
  - @cat-factory/acceptance-kit@0.7.10
  - @cat-factory/cli@0.14.0
  - @cat-factory/sdk@0.51.2

## 0.4.68

### Patch Changes

- Updated dependencies [aafc0f9]
  - @cat-factory/cli@0.14.0

## 0.4.67

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0
  - @cat-factory/acceptance-kit@0.7.9
  - @cat-factory/cli@0.13.7
  - @cat-factory/sdk@0.51.2

## 0.4.66

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0
  - @cat-factory/acceptance-kit@0.7.8
  - @cat-factory/cli@0.13.7

## 0.4.65

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0
  - @cat-factory/acceptance-kit@0.7.7
  - @cat-factory/cli@0.13.7

## 0.4.64

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0
  - @cat-factory/acceptance-kit@0.7.6
  - @cat-factory/cli@0.13.7
  - @cat-factory/sdk@0.51.2

## 0.4.63

### Patch Changes

- Updated dependencies [5c50d30]
  - @cat-factory/acceptance-kit@0.7.5
  - @cat-factory/cli@0.13.7
  - @cat-factory/contracts@0.346.2
  - @cat-factory/kernel@0.336.1
  - @cat-factory/sdk@0.51.2

## 0.4.62

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/acceptance-kit@0.7.4
  - @cat-factory/cli@0.13.6
  - @cat-factory/kernel@0.336.0
  - @cat-factory/sdk@0.51.1

## 0.4.61

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1
  - @cat-factory/acceptance-kit@0.7.3
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.51.0

## 0.4.60

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0
  - @cat-factory/acceptance-kit@0.7.2
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.51.0

## 0.4.59

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0
  - @cat-factory/acceptance-kit@0.7.1
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.51.0

## 0.4.58

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0
  - @cat-factory/sdk@0.51.0
  - @cat-factory/acceptance-kit@0.7.0
  - @cat-factory/cli@0.13.5

## 0.4.57

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0
  - @cat-factory/acceptance-kit@0.6.16
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.50.0

## 0.4.56

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0
  - @cat-factory/acceptance-kit@0.6.15
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.50.0

## 0.4.55

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0
  - @cat-factory/acceptance-kit@0.6.14
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.50.0

## 0.4.54

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0
  - @cat-factory/sdk@0.50.0
  - @cat-factory/acceptance-kit@0.6.13
  - @cat-factory/cli@0.13.5

## 0.4.53

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0
  - @cat-factory/acceptance-kit@0.6.12
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.49.0

## 0.4.52

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0
  - @cat-factory/acceptance-kit@0.6.11
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.49.0

## 0.4.51

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0
  - @cat-factory/acceptance-kit@0.6.10
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.49.0

## 0.4.50

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0
  - @cat-factory/sdk@0.49.0
  - @cat-factory/acceptance-kit@0.6.9
  - @cat-factory/cli@0.13.5

## 0.4.49

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0
  - @cat-factory/acceptance-kit@0.6.8
  - @cat-factory/cli@0.13.5
  - @cat-factory/sdk@0.48.1

## 0.4.48

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2
  - @cat-factory/acceptance-kit@0.6.7
  - @cat-factory/cli@0.13.5

## 0.4.47

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1
  - @cat-factory/acceptance-kit@0.6.6
  - @cat-factory/cli@0.13.5

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

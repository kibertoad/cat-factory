# @cat-factory/example-custom-agent

## 0.0.82

### Patch Changes

- Updated dependencies [858799e]
  - @cat-factory/kernel@0.62.0
  - @cat-factory/agents@0.24.3

## 0.0.81

### Patch Changes

- @cat-factory/agents@0.24.2
- @cat-factory/kernel@0.61.1

## 0.0.80

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1

## 0.0.79

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/agents@0.24.0

## 0.0.78

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/agents@0.23.4

## 0.0.77

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/agents@0.23.3

## 0.0.76

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/kernel@0.57.1

## 0.0.75

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/kernel@0.57.0
  - @cat-factory/agents@0.23.1

## 0.0.74

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/agents@0.23.0
  - @cat-factory/kernel@0.56.1

## 0.0.73

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0
  - @cat-factory/agents@0.22.6

## 0.0.72

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/agents@0.22.5

## 0.0.71

### Patch Changes

- @cat-factory/agents@0.22.4
- @cat-factory/kernel@0.55.3

## 0.0.70

### Patch Changes

- @cat-factory/agents@0.22.3
- @cat-factory/kernel@0.55.2

## 0.0.69

### Patch Changes

- @cat-factory/agents@0.22.2
- @cat-factory/kernel@0.55.1

## 0.0.68

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/agents@0.22.1

## 0.0.67

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/agents@0.22.0

## 0.0.66

### Patch Changes

- @cat-factory/agents@0.21.17
- @cat-factory/kernel@0.53.1

## 0.0.65

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0
  - @cat-factory/agents@0.21.16

## 0.0.64

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/agents@0.21.15

## 0.0.63

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0
  - @cat-factory/agents@0.21.14

## 0.0.62

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0
  - @cat-factory/agents@0.21.13

## 0.0.61

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0
  - @cat-factory/agents@0.21.12

## 0.0.60

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0
  - @cat-factory/agents@0.21.11

## 0.0.59

### Patch Changes

- @cat-factory/agents@0.21.10
- @cat-factory/kernel@0.47.2

## 0.0.58

### Patch Changes

- @cat-factory/agents@0.21.9
- @cat-factory/kernel@0.47.1

## 0.0.57

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/agents@0.21.8

## 0.0.56

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/agents@0.21.7

## 0.0.55

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6

## 0.0.54

### Patch Changes

- @cat-factory/agents@0.21.5
- @cat-factory/kernel@0.45.4

## 0.0.53

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/agents@0.21.4

## 0.0.52

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/kernel@0.45.2

## 0.0.51

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2

## 0.0.50

### Patch Changes

- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0
  - @cat-factory/agents@0.21.1

## 0.0.49

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0

## 0.0.48

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3

## 0.0.47

### Patch Changes

- @cat-factory/agents@0.20.2
- @cat-factory/kernel@0.42.2

## 0.0.46

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1

## 0.0.45

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/agents@0.20.0

## 0.0.44

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0

## 0.0.43

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/kernel@0.40.0
  - @cat-factory/agents@0.18.5

## 0.0.42

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/kernel@0.39.0
  - @cat-factory/agents@0.18.4

## 0.0.41

### Patch Changes

- @cat-factory/agents@0.18.3
- @cat-factory/kernel@0.38.1

## 0.0.40

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2

## 0.0.39

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1

## 0.0.38

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/agents@0.18.0

## 0.0.37

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/kernel@0.36.0
  - @cat-factory/agents@0.17.2

## 0.0.36

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/kernel@0.35.0
  - @cat-factory/agents@0.17.1

## 0.0.35

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0

## 0.0.34

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1

## 0.0.33

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0

## 0.0.32

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/kernel@0.32.0
  - @cat-factory/agents@0.15.2

## 0.0.31

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/agents@0.15.1

## 0.0.30

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/agents@0.15.0

## 0.0.29

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/agents@0.14.9

## 0.0.28

### Patch Changes

- @cat-factory/agents@0.14.8
- @cat-factory/kernel@0.28.1

## 0.0.27

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/kernel@0.28.0
  - @cat-factory/agents@0.14.7

## 0.0.26

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/kernel@0.27.0
  - @cat-factory/agents@0.14.6

## 0.0.25

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/agents@0.14.5

## 0.0.24

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4

## 0.0.23

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/agents@0.14.3

## 0.0.22

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/kernel@0.24.0
  - @cat-factory/agents@0.14.2

## 0.0.21

### Patch Changes

- 7346a4f: Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
  extensible, so a company-authored deployment package can register its OWN full-blown gate
  (deterministic probe + helper/companion agent + exhaustion handling) or step resolver
  purely via an import side effect — exactly the way it already registers a custom agent
  kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

  - **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
    `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
    `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
    `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
    extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
    `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
    registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
    registry-build time — solving the `this`-capture the built-in gates rely on while
    keeping them inline and unchanged.
  - **orchestration**: `ExecutionService.buildGateRegistry()` /
    `buildStepResolverRegistry()` now merge the deployment-registered factories with the
    built-ins (registered replaces built-in of the same kind, last-wins) via new
    `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
    re-exported from the package index for discovery.
  - **example-custom-agent**: registers a `license-check` gate (escalating to a new
    `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
    proving a custom gate ships with zero engine changes.
  - **conformance**: a new cross-runtime assertion drives a registered custom gate
    (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/agents@0.14.1

## 0.0.20

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0

## 0.0.19

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0

## 0.0.18

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0

## 0.0.17

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/kernel@0.19.0
  - @cat-factory/agents@0.11.16

## 0.0.16

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/kernel@0.18.0
  - @cat-factory/agents@0.11.15

## 0.0.15

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/kernel@0.17.0
  - @cat-factory/agents@0.11.14

## 0.0.14

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13

## 0.0.13

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12

## 0.0.12

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11

## 0.0.11

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/agents@0.11.10

## 0.0.10

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/agents@0.11.9

## 0.0.9

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8

## 0.0.8

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/kernel@0.14.0
  - @cat-factory/agents@0.11.7

## 0.0.7

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/kernel@0.13.4

## 0.0.6

### Patch Changes

- @cat-factory/agents@0.11.5
- @cat-factory/kernel@0.13.3

## 0.0.5

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4

## 0.0.4

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3

## 0.0.3

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/kernel@0.13.0
  - @cat-factory/agents@0.11.2

## 0.0.2

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1

## 0.0.1

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0

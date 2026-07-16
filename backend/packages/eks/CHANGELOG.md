# @cat-factory/eks

## 0.1.82

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1
  - @cat-factory/integrations@0.84.4

## 0.1.81

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/integrations@0.84.3

## 0.1.80

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1

## 0.1.79

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/integrations@0.84.1

## 0.1.78

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/integrations@0.84.0

## 0.1.77

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/integrations@0.83.3

## 0.1.76

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2

## 0.1.75

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/integrations@0.83.1

## 0.1.74

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0

## 0.1.73

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0

## 0.1.72

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20

## 0.1.71

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19

## 0.1.70

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/integrations@0.81.18

## 0.1.69

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1
  - @cat-factory/integrations@0.81.17

## 0.1.68

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/integrations@0.81.16

## 0.1.67

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/integrations@0.81.15

## 0.1.66

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14

## 0.1.65

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/integrations@0.81.13

## 0.1.64

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/integrations@0.81.12

## 0.1.63

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/contracts@0.127.1
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5

## 0.1.62

### Patch Changes

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10

## 0.1.61

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/integrations@0.81.9

## 0.1.60

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/integrations@0.81.8

## 0.1.59

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/integrations@0.81.7

## 0.1.58

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2

## 0.1.57

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/integrations@0.81.5

## 0.1.56

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/integrations@0.81.4

## 0.1.55

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/integrations@0.81.3

## 0.1.54

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0
  - @cat-factory/integrations@0.81.2

## 0.1.53

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1

## 0.1.52

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/integrations@0.81.0

## 0.1.51

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/integrations@0.80.6

## 0.1.50

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/integrations@0.80.5

## 0.1.49

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/integrations@0.80.4

## 0.1.48

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/integrations@0.80.3

## 0.1.47

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/integrations@0.80.2

## 0.1.46

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1

## 0.1.45

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0

## 0.1.44

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/integrations@0.79.3

## 0.1.43

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1
  - @cat-factory/integrations@0.79.2

## 0.1.42

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/integrations@0.79.1

## 0.1.41

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/integrations@0.79.0

## 0.1.40

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2
  - @cat-factory/integrations@0.78.8

## 0.1.39

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1

## 0.1.38

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/integrations@0.78.6

## 0.1.37

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1

## 0.1.36

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/integrations@0.78.4

## 0.1.35

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1
  - @cat-factory/integrations@0.78.3

## 0.1.34

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/integrations@0.78.2

## 0.1.33

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/integrations@0.78.1

## 0.1.32

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/integrations@0.78.0

## 0.1.31

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0
  - @cat-factory/integrations@0.77.8

## 0.1.30

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0
  - @cat-factory/integrations@0.77.7

## 0.1.29

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0
  - @cat-factory/integrations@0.77.6

## 0.1.28

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0

## 0.1.27

### Patch Changes

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4

## 0.1.26

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4

## 0.1.25

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3

## 0.1.24

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/integrations@0.77.1

## 0.1.23

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.1.22

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0

## 0.1.21

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/integrations@0.75.1

## 0.1.20

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0

## 0.1.19

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/kernel@0.101.2

## 0.1.18

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6

## 0.1.17

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/integrations@0.73.5

## 0.1.16

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/integrations@0.73.4

## 0.1.15

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/integrations@0.73.3

## 0.1.14

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1

## 0.1.13

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1

## 0.1.12

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0

## 0.1.11

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.1.10

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0

## 0.1.9

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/integrations@0.71.0

## 0.1.8

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/integrations@0.70.1

## 0.1.7

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0

## 0.1.6

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.1.5

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0

## 0.1.4

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0

## 0.1.3

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/integrations@0.67.1

## 0.1.2

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/integrations@0.67.0

## 0.1.1

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1

## 0.1.0

### Minor Changes

- 48f9d97: Add opt-in AWS EKS runner + environment backends as a new standalone package
  `@cat-factory/eks`. An EKS cluster's apiserver is a standard Kubernetes apiserver, so the
  package reuses the native Kubernetes transport/provider from `@cat-factory/integrations`
  verbatim and only supplies the EKS differentiator: a short-lived SigV4-presigned STS (IAM)
  apiserver token, minted with WebCrypto (no runtime AWS SDK dependency).

  - `@cat-factory/contracts`: new first-class `{ kind: 'eks' }` runner + environment backend
    variants (`eksRunnerConfigSchema` / `eksProvisionConfigSchema`), the shared
    `eksClusterFieldsSchema` (`region` / `clusterName` / optional `stsHost`, now shape-validated),
    and the AWS secret-key constants. `'eks'` is now a reserved backend kind. `ProviderConfigField`
    gains `number` / `checkbox` / `textarea` field types, and `ProviderDescriptor` gains
    `configTemplate` / `values` so a native backend's typed config renders as a generic form.
  - `@cat-factory/integrations`: `KubernetesApiClient` gains an optional async token-provider
    seam (behaviour-preserving for the existing Kubernetes backend). `RunnerBackendProvider` gains
    an optional `form` descriptor (the shared apiserver fields live once in
    `kubernetesLogic.KUBERNETES_RUNNER_FORM_FIELDS`), so the Kubernetes/EKS runner backends
    self-describe their connect form.
  - `@cat-factory/node-server` + `@cat-factory/worker`: register the EKS backends by reference on
    BOTH facades (symmetric with the native `kubernetes` backend they extend; a pass-through until
    a workspace connects an `eks` backend). A real EKS cluster's private-CA apiserver is only
    reachable from a runtime that can pin a custom CA (Node/local) — the same constraint a
    private-CA `kubernetes` connection already carries, rejected up front at registration on the
    Worker rather than failing silently.
  - `@cat-factory/app`: the runner-pool connect form is now rendered generically from the backend
    descriptor for every backend kind (built-in `kubernetes`, opt-in `eks`, and custom native
    kinds) — the hardcoded `KubernetesRunnerForm.vue` was removed and the SPA no longer knows which
    optional backends exist. See `docs/initiatives/descriptor-driven-infra-forms.md` for the
    remaining env-axis + manifest-editor work.

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/integrations@0.66.0

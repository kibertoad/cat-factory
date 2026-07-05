# @cat-factory/eks

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

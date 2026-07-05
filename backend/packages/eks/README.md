# @cat-factory/eks

Opt-in AWS **EKS** backends for cat-factory — a runner backend (per-run agent pods) and an
ephemeral-environment backend (per-PR namespaces), both on an Amazon EKS cluster.

## Why this is a thin package

An EKS cluster's API server **is** a standard Kubernetes API server, so this package **reuses
the entire native Kubernetes transport/provider** from `@cat-factory/integrations`
(`KubernetesRunnerTransport`, `KubernetesEnvironmentProvider`, `KubernetesApiClient`) verbatim.
The only EKS-specific piece is **authentication**: EKS doesn't use a static ServiceAccount
bearer token — it expects a short-lived IAM token (a SigV4-presigned STS `GetCallerIdentity`
URL, prefixed `k8s-aws-v1.`, the exact token `aws eks get-token` produces). That token is
minted here with WebCrypto (`eks-auth.logic.ts`), so the package carries **no runtime AWS SDK
dependency** and is runtime-neutral. It's injected through the async token seam
`KubernetesApiClient` exposes, so no transport logic is duplicated.

## Enabling it

The backends are **not** in the default registries (which stay AWS-free). A facade opts in by
registering them **by reference** from its composition root (the Node/local facades already do
this in `backend/runtimes/node/src/container.ts`):

```ts
import { eksRunnerBackend, eksEnvironmentBackend } from '@cat-factory/eks'
registries.runnerBackendRegistry.register(eksRunnerBackend)
registries.environmentBackendRegistry.register(eksEnvironmentBackend)
```

A workspace then connects an `eks` runner/environment backend with an `EksRunnerConfig` /
`EksProvisionConfig` (the Kubernetes config — apiserver endpoint, CA, namespace, image — plus
`region` + `clusterName`), and the AWS credentials (`awsAccessKeyId` / `awsSecretAccessKey` /
optional `awsSessionToken`) in the write-only secret bundle.

Both facades register the backends by reference (`backend/runtimes/node/src/container.ts` and
`backend/runtimes/cloudflare/src/infrastructure/container.ts`), keeping the runtimes symmetric
with the native `kubernetes` backend they extend.

> **Runtime reach.** A real EKS cluster's apiserver presents a **private CA**, which only a
> runtime that can pin a custom CA (Node/local, via `undici`) can verify — the SAME constraint a
> private-CA `kubernetes` connection already carries. The Worker registers the `eks` kind for
> symmetry, but a connection to such a cluster is rejected up front at registration when the
> runtime can't honor the custom CA (`customTlsSupported: false`), so it fails loudly rather than
> silently at first dispatch.

### UI reach

The **runner** backend is a first-class UI citizen: it self-describes its connect form via the
`RunnerBackendProvider.form` descriptor, so the SPA renders it generically (region / cluster /
credentials + the shared apiserver fields) with **no** EKS-specific frontend code — the same
descriptor-driven path the built-in Kubernetes runner backend now uses.

The **environment** backend is functional when resolved by kind, but is not yet surfaced as its
own first-class environment _engine_ in the SPA infra-handler selector (the connect flow would
lower to `{ kind: 'eks' }` rather than `{ kind: 'kubernetes' }`). That needs a dedicated
`InfraEngine('eks')` threaded through the contract engine union + `handlerConfigToBackendConfig`

- the per-provision-type SPA forms — tracked in
  [`docs/initiatives/descriptor-driven-infra-forms.md`](../../../docs/initiatives/descriptor-driven-infra-forms.md).

## Tests

- **Unit** (`pnpm --filter @cat-factory/eks test:run`, runs in the required CI gate): the
  SigV4/STS token minter golden vector + the `{ kind: 'eks' }` contract round-trip. No cluster.
- **Integration** (`pnpm --filter @cat-factory/eks test:integration`): drives the EKS
  transport/provider against a **real** apiserver. Self-skips unless `EKS_IT_*` is set. Runs in
  the **non-blocking** `test-eks` CI job (see `.github/workflows/ci.yml`).

### Running the integration suite against floci

[floci](https://floci.io) is a local, LocalStack-compatible AWS emulator whose EKS "real mode"
stands up a **real k3s container per EKS cluster** and exposes its Kubernetes API server on a host
port. Boot floci (pinned to the version this suite is validated against), create a cluster with the
AWS CLI, then export the connection:

```sh
docker run -d --name floci -p 4566:4566 -v /var/run/docker.sock:/var/run/docker.sock -u root floci/floci:1.5.30
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
aws --endpoint-url=http://localhost:4566 eks create-cluster --name cat-factory-it \
  --role-arn arn:aws:iam::000000000000:role/eks --resources-vpc-config '{}'
# ...wait for ACTIVE, then read endpoint + CA:
export EKS_IT_APISERVER=$(aws --endpoint-url=http://localhost:4566 eks describe-cluster --name cat-factory-it --query cluster.endpoint --output text)
export EKS_IT_REGION=us-east-1 EKS_IT_CLUSTER_NAME=cat-factory-it
export EKS_IT_ACCESS_KEY_ID=test EKS_IT_SECRET_ACCESS_KEY=test
export EKS_IT_STS_HOST=localhost:4566 EKS_IT_INSECURE=1
export EKS_IT_RUNNER_IMAGE=cat-factory-mock-harness:it   # runner suite only
pnpm --filter @cat-factory/eks run test:integration
```

The `stsHost` override (`EKS_IT_STS_HOST` → the config's `stsHost`) points the presigned STS
`GetCallerIdentity` URL at floci instead of real AWS. See `src/test-support/eks-cluster.ts` for the
full env list and for exactly what floci does — and does not — cover at the auth layer.

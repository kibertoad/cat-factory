import { beforeAll, describe, expect, it } from 'vitest'
import { EksEnvironmentProvider } from './EksEnvironmentProvider.js'
import { eksEnvironmentBackend } from './eks-environment-backend.js'
import {
  awsSecretResolver,
  eksEnvConfig,
  eksSkipReason,
  readEksClusterEnv,
  uniqueSuffix,
} from './test-support/eks-cluster.js'

// INTEGRATION: drives EksEnvironmentProvider against a REAL apiserver fronted by an
// EKS-compatible API (a floci-emulated EKS cluster in CI). It reuses the entire native
// Kubernetes environment provider behind a MINTED IAM apiserver token, so this validates that
// the minted-token client reaches a real apiserver for the read (testConnection) and delete
// (teardown) paths. The per-PR namespace apply/status flow is identical to the Kubernetes suite
// (same code path) and needs a RepoFiles manifest fixture, so it is covered there. Self-skips
// with a clear reason when `EKS_IT_*` is unset (see test-support/eks-cluster.ts).

const env = readEksClusterEnv()
const skip = eksSkipReason(env)

describe.skipIf(skip !== null)(
  `EksEnvironmentProvider (floci EKS integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    const cluster = env as NonNullable<typeof env>
    let provider: EksEnvironmentProvider
    // The stored manifest the provider parses its config out of (built via the backend, exactly
    // as the connection service would persist it). Built in beforeAll — which `describe.skipIf`
    // skips — since `cluster` is only non-null when the suite actually runs.
    let manifest: ReturnType<typeof eksEnvironmentBackend.toManifest>

    beforeAll(() => {
      provider = new EksEnvironmentProvider()
      manifest = eksEnvironmentBackend.toManifest({ kind: 'eks', eks: eksEnvConfig(cluster) })
    })

    it('testConnection reaches the apiserver with the minted IAM token', async () => {
      const result = await provider.testConnection({
        manifest,
        config: {},
        resolveSecret: awsSecretResolver(cluster),
      })
      expect(result.ok).toBe(true)
    })

    it('teardown of an absent namespace is idempotent (minted-token DELETE, 404-tolerant)', async () => {
      const result = await provider.teardown({
        manifest,
        externalId: `cf-env-absent-${uniqueSuffix()}`,
        provisionFields: {},
        resolveSecret: awsSecretResolver(cluster),
      })
      expect(result.status).toBe('torn_down')
    })
  },
)

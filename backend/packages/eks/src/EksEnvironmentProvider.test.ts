import type { EksProvisionConfig } from '@cat-factory/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EksEnvironmentProvider } from './EksEnvironmentProvider.js'
import { eksEnvironmentBackend } from './eks-environment-backend.js'

// The provider is the native Kubernetes one with a MINTED apiserver token, so the only thing
// unique to it is that the AWS coordinates reach the minter. That is not self-evident: every
// parse on the way there runs a valibot object, which drops entries it does not declare, so an
// inherited Kubernetes parse hands on a config with no `region` at all and the token is presigned
// against `sts.undefined.amazonaws.com` — a failure that surfaces as an apiserver 401, several
// layers from its cause. These pin the coordinates surviving BOTH reads: the full config a
// provision parses, and the narrow connection a reclaim parses.

const config: EksProvisionConfig = {
  label: 'prod-eks',
  apiServerUrl: 'https://ABC123.gr7.us-east-1.eks.amazonaws.com',
  manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
  url: { source: 'serviceStatus', serviceName: 'web' },
  region: 'us-east-1',
  clusterName: 'prod',
}
const manifest = eksEnvironmentBackend.toManifest({ kind: 'eks', eks: config })
const resolveSecret = (key: string) =>
  ({ awsAccessKeyId: 'AKIA_TEST', awsSecretAccessKey: 'secret' })[key]

/** Reaches the two protected parses the way the provider's own methods do. */
class Probe extends EksEnvironmentProvider {
  readConfig = (m: typeof manifest) => this.parseConfig(m)
  readConnection = (m: typeof manifest) => this.parseConnection(m)
}

afterEach(() => vi.unstubAllGlobals())

describe('EksEnvironmentProvider config reads', () => {
  it('keeps the AWS coordinates on the full provision config', () => {
    expect(new Probe().readConfig(manifest)).toMatchObject({
      region: 'us-east-1',
      clusterName: 'prod',
      manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
    })
  })

  it('keeps them on the reclaim-path connection too, dropping only the provisioning half', () => {
    // The token is minted per call, teardown included, so a connection without them cannot even
    // authenticate the DELETE.
    const connection = new Probe().readConnection(manifest)
    expect(connection).toMatchObject({ region: 'us-east-1', clusterName: 'prod' })
    expect(connection).not.toHaveProperty('manifestSource')
  })

  it('reclaims a namespace whose stored PROVISIONING config no longer validates', async () => {
    // The EKS half of the same property the Kubernetes suite pins: drift in a field the delete
    // never reads must not be what leaves a per-PR namespace running in a real cluster.
    const drifted = { ...manifest, providerConfig: { ...config, url: { source: 'retired' } } }
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        calls.push(input.toString())
        return new Response('{}', { status: 404 })
      }),
    )

    const result = await new EksEnvironmentProvider().teardown({
      manifest: drifted,
      externalId: 'cf-env-42',
      provisionFields: { namespace: 'cf-env-42' },
      resolveSecret,
    })

    expect(result.status).toBe('torn_down')
    expect(calls[0]).toContain('/api/v1/namespaces/cf-env-42')
  })
})

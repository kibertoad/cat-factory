// Spec 00: everything that must be true before the suite is allowed to spend anything.
//
// The whole point of this file is that it is CHEAP and comes FIRST. Every check here has a
// counterpart failure much later in the run, wearing a much worse face: a key bound to another
// workspace looks like a deployment that lost its board, an unreachable cluster looks like a
// broken `deployer` step, and an absent public API looks like the SDK. Spending four HTTP calls
// to say which of those it really is buys back an afternoon.
//
// It asserts NOTHING about the product. It is a setup check, and it says so in every message.

import { beforeAll, describe, expect, it } from 'vitest'
import { assertKeyUsable } from '../src/publicApi.ts'
import { buildK3sHandlerConfig, buildK3sSecrets, renderEnvironmentHost } from '../src/k3s.ts'
import { harness } from './fixtures.ts'

describe('preflight: the deployment, the key and the cluster', () => {
  const { config, client, app } = harness()

  beforeAll(() => {
    console.log(`preflight against ${config.baseUrl} (workspace ${config.workspaceId})`)
  })

  it('serves the public API and the key is usable for everything this suite does', async () => {
    const identity = await client.me.get()
    // Throws with the specific mismatch (wrong workspace / insufficient scope) rather than
    // leaving `expect` to report two opaque strings that differ.
    assertKeyUsable(identity, config.workspaceId)
    expect(identity.scope).toBe('admin')
  })

  it('exposes a pipeline catalog including the two presets this suite drives', async () => {
    const { pipelines } = await client.pipelines.list()
    const ids = pipelines.map((pipeline) => pipeline.pipelineId)
    // A board that predates a catalog pipeline holds no row for it and MATERIALISES one on first
    // start, so an id missing here is not fatal, which is exactly why this is reported rather
    // than asserted. What it buys is a named heads-up before spec 02 starts a run on `pl_build`.
    for (const wanted of ['pl_build', 'pl_bugfix']) {
      if (!ids.includes(wanted)) {
        console.warn(
          `  note: '${wanted}' is not among this board's adopted pipelines (${ids.join(', ') || 'none'}). ` +
            `A run naming it will adopt it on first start, so this is a heads-up, not a failure.`,
        )
      }
    }
    expect(pipelines.length).toBeGreaterThan(0)
  })

  it('can reach the k3s apiserver with the supplied ServiceAccount token', async () => {
    // The one call that probes the cluster WITHOUT persisting anything. Its whole value is
    // timing: the same credential failure discovered by a `deployer` step arrives after a design
    // pass and an implementation have already been paid for.
    const result = await app.testEnvironmentHandler(
      buildK3sHandlerConfig(config.cluster),
      buildK3sSecrets(config.cluster),
    )
    if (!result.ok) {
      throw new Error(
        `The k3s connection probe failed: ${result.message ?? '(no message)'}\n` +
          `  apiserver: ${config.cluster.apiServerUrl}\n` +
          `  TLS: ${config.cluster.caCertPem ? 'custom CA' : `insecureSkipTlsVerify=${config.cluster.insecureSkipTlsVerify}`}\n` +
          `  The ServiceAccount needs the RBAC in backend/docs/local-k3s-environments.md, ` +
          `including the cluster-wide grant that lets it create per-PR namespaces.`,
      )
    }
    expect(result.ok).toBe(true)
  })

  it('derives a reachable environment host from the configured template', () => {
    // Rendered against a sample namespace only: the real one carries a pull-request number this
    // suite has not produced yet. What it proves is that the template has no hole the platform
    // cannot fill, which is the failure that otherwise surfaces as an environment stuck
    // `provisioning` with a URL nobody can resolve.
    const host = renderEnvironmentHost(config.cluster.ingressHostTemplate, 'cf-acc-1')
    if (host === null) {
      throw new Error(
        `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE ('${config.cluster.ingressHostTemplate}') still has ` +
          `an unrendered placeholder after substituting {{namespace}}. This suite only knows that ` +
          `one before a run opens its pull request; use a template built from it.`,
      )
    }
    expect(host).toContain('cf-acc-1')
  })
})

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
} from '@cat-factory/contracts'
import type { SecretResolver } from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EksRunnerTransport } from './EksRunnerTransport.js'

// WIRE coverage for the EKS auth SEAM (no cluster, runs in the required unit lane). The
// golden-vector test proves the token STRING is a correct SigV4 presign; this proves the minted
// token actually flows through KubernetesApiClient onto the apiserver request's `Authorization`
// header when the EKS transport talks to a server — i.e. the token-provider seam is wired end to
// end (mint → client → wire), which floci integration would otherwise be the only thing to cover.
// A tiny local HTTP server stands in for the apiserver and captures the header it receives.

const AWS_SECRETS: SecretResolver = (key) =>
  ({
    [EKS_ACCESS_KEY_ID_SECRET_KEY]: 'AKIDEXAMPLE',
    [EKS_SECRET_ACCESS_KEY_SECRET_KEY]: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  })[key]

describe('EKS auth wire seam', () => {
  let server: Server
  let received: { authorization?: string; path?: string }

  beforeEach(async () => {
    received = {}
    server = createServer((req, res) => {
      received.authorization = req.headers.authorization
      received.path = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ kind: 'PodList', items: [] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends the minted k8s-aws-v1 IAM token as the apiserver Bearer token', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new EksRunnerTransport(
      {
        label: 'wire-test',
        apiServerUrl: `http://127.0.0.1:${port}`,
        namespace: 'cat-factory',
        image: 'example/executor:test',
        region: 'us-east-1',
        clusterName: 'wire-cluster',
      },
      AWS_SECRETS,
    )

    const result = await transport.testConnection()
    expect(result.ok).toBe(true)

    // The apiserver saw a Bearer token, and it is the EKS presigned-STS envelope.
    const auth = received.authorization ?? ''
    expect(auth.startsWith('Bearer k8s-aws-v1.')).toBe(true)
    const presigned = Buffer.from(auth.slice('Bearer k8s-aws-v1.'.length), 'base64url').toString(
      'utf8',
    )
    const url = new URL(presigned)
    expect(url.host).toBe('sts.us-east-1.amazonaws.com')
    expect(url.searchParams.get('Action')).toBe('GetCallerIdentity')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // The request actually hit the namespaced pods endpoint (so it's the real transport path).
    expect(received.path).toContain('/namespaces/cat-factory/pods')
  })
})

import { describe, expect, it } from 'vitest'
import { type EksAwsCredentials, eksTokenProvider, mintEksToken } from './eks-auth.logic.js'

// Deterministic inputs — a fixed timestamp makes the SigV4 presign a pure function, so the
// token is reproducible and its structure can be asserted precisely. These are throwaway
// example credentials (the canonical AWS SigV4 documentation example key), NOT real secrets.
const CREDENTIALS: EksAwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}
const FIXED_NOW = Date.UTC(2026, 6, 1, 12, 0, 0) // 2026-07-01T12:00:00Z

/** Decode the `k8s-aws-v1.<base64url>` token back to its presigned STS URL. */
function decodeToken(token: string): URL {
  expect(token.startsWith('k8s-aws-v1.')).toBe(true)
  const b64 = token.slice('k8s-aws-v1.'.length)
  return new URL(Buffer.from(b64, 'base64url').toString('utf8'))
}

describe('mintEksToken', () => {
  it('produces a k8s-aws-v1 presigned STS GetCallerIdentity URL bound to the cluster', async () => {
    const token = await mintEksToken({
      region: 'us-east-1',
      clusterName: 'my-cluster',
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    })
    const url = decodeToken(token)
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('sts.us-east-1.amazonaws.com')
    const q = url.searchParams
    expect(q.get('Action')).toBe('GetCallerIdentity')
    expect(q.get('Version')).toBe('2011-06-15')
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    // Credential scope: <accessKeyId>/<YYYYMMDD>/<region>/sts/aws4_request
    expect(q.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20260701/us-east-1/sts/aws4_request')
    expect(q.get('X-Amz-Date')).toBe('20260701T120000Z')
    expect(q.get('X-Amz-Expires')).toBe('60')
    // The cluster name is bound via a SIGNED header, so it appears in SignedHeaders (not the query).
    expect(q.get('X-Amz-SignedHeaders')).toBe('host;x-k8s-aws-id')
    // A real signature: 64 lowercase hex chars.
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // No temporary-credential token unless one was supplied.
    expect(q.get('X-Amz-Security-Token')).toBeNull()
  })

  it('is deterministic for identical inputs', async () => {
    const params = {
      region: 'eu-west-1',
      clusterName: 'c1',
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    }
    expect(await mintEksToken(params)).toBe(await mintEksToken(params))
  })

  it('binds the signature to the cluster name (different cluster ⇒ different signature)', async () => {
    const base = { region: 'us-east-1', credentials: CREDENTIALS, now: FIXED_NOW }
    const a = decodeToken(await mintEksToken({ ...base, clusterName: 'cluster-a' }))
    const b = decodeToken(await mintEksToken({ ...base, clusterName: 'cluster-b' }))
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'))
  })

  it('folds temporary-credential session tokens into X-Amz-Security-Token', async () => {
    const token = await mintEksToken({
      region: 'us-east-1',
      clusterName: 'my-cluster',
      credentials: { ...CREDENTIALS, sessionToken: 'FQoGZXIvYXdzEXAMPLETOKEN' },
      now: FIXED_NOW,
    })
    expect(decodeToken(token).searchParams.get('X-Amz-Security-Token')).toBe(
      'FQoGZXIvYXdzEXAMPLETOKEN',
    )
  })

  it('targets a custom STS host (e.g. a floci-emulated endpoint) when provided', async () => {
    const token = await mintEksToken({
      region: 'us-east-1',
      clusterName: 'my-cluster',
      credentials: CREDENTIALS,
      now: FIXED_NOW,
      stsHost: 'localhost:4566',
    })
    expect(decodeToken(token).host).toBe('localhost:4566')
  })

  // Regression pin: guards the exact signing algorithm against accidental change. If the SigV4
  // canonicalization/scope/host changes, this fails — re-derive only after cross-checking a
  // real `aws eks get-token` vector.
  it('matches the pinned regression signature', async () => {
    const token = await mintEksToken({
      region: 'us-east-1',
      clusterName: 'my-cluster',
      credentials: CREDENTIALS,
      now: FIXED_NOW,
    })
    expect(decodeToken(token).searchParams.get('X-Amz-Signature')).toBe(REGRESSION_SIGNATURE)
  })
})

describe('eksTokenProvider', () => {
  it('reads AWS credentials from the secret bundle and mints a token', async () => {
    const secrets: Record<string, string> = {
      awsAccessKeyId: 'AKIDEXAMPLE',
      awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    }
    const provider = eksTokenProvider(
      { region: 'us-east-1', clusterName: 'my-cluster' },
      (key) => secrets[key],
    )
    const token = await provider()
    expect(token.startsWith('k8s-aws-v1.')).toBe(true)
    // Cached within the guard window — a second call returns the same token.
    expect(await provider()).toBe(token)
  })

  it('throws a clear error when the AWS credentials are absent', async () => {
    const provider = eksTokenProvider(
      { region: 'us-east-1', clusterName: 'my-cluster' },
      () => undefined,
    )
    await expect(provider()).rejects.toThrow(/Missing AWS credentials for EKS/)
  })
})

// Pinned from the minter's output (see the regression test above).
const REGRESSION_SIGNATURE = '566895689cdf5cc1e77486d8699069bd7f479cc8a137b0335cf4b837c516ab1c'

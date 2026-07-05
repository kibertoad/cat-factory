import type { EksRunnerConfig } from '@cat-factory/contracts'
import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  EKS_SESSION_TOKEN_SECRET_KEY,
} from '@cat-factory/contracts'
import type { RunnerBackendConfig } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { eksRunnerBackend } from './eks-runner-backend.js'

// The `form` descriptor is what lets the SPA render the EKS connect form generically (no
// hardcoded per-kind component). These assert its three pieces are consistent so the SPA's
// overlay round-trip (fields → config, config → prefill values) can't silently break.

const form = eksRunnerBackend.form!

const CONFIG: EksRunnerConfig = {
  label: 'prod-eks',
  apiServerUrl: 'https://abc.gr7.us-east-1.eks.amazonaws.com',
  namespace: 'cat-factory',
  image: 'ghcr.io/kibertoad/cat-factory-executor:latest',
  region: 'us-east-1',
  clusterName: 'prod',
  harnessPort: 8080,
  insecureSkipTlsVerify: true,
}

describe('eksRunnerBackend.form', () => {
  it('exposes the AWS cluster fields + credential secrets alongside the shared apiserver fields', () => {
    const keys = form.fields().map((f) => f.key)
    // Shared apiserver fields (from the Kubernetes backend) …
    expect(keys).toEqual(expect.arrayContaining(['label', 'apiServerUrl', 'namespace', 'image']))
    // … plus the EKS-specific fields.
    expect(keys).toEqual(expect.arrayContaining(['region', 'clusterName', 'stsHost']))
    // The AWS credentials are secret fields (so they route to the write-only bundle).
    const secretKeys = form
      .fields()
      .filter((f) => f.secret)
      .map((f) => f.key)
    expect(secretKeys).toEqual(
      expect.arrayContaining([EKS_ACCESS_KEY_ID_SECRET_KEY, EKS_SECRET_ACCESS_KEY_SECRET_KEY]),
    )
    // The session token is optional (not required).
    const sessionField = form.fields().find((f) => f.key === EKS_SESSION_TOKEN_SECRET_KEY)
    expect(sessionField?.required).toBeFalsy()
  })

  it('skeletons an { kind: "eks", eks } config for the SPA to overlay onto', () => {
    expect(form.skeleton()).toEqual({ kind: 'eks', eks: {} })
  })

  it('inverts a stored config into flat non-secret values (stringified) for prefill', () => {
    const values = form.valuesFromConfig({ kind: 'eks', eks: CONFIG } as RunnerBackendConfig)
    expect(values).toMatchObject({
      label: 'prod-eks',
      region: 'us-east-1',
      clusterName: 'prod',
      harnessPort: '8080',
      insecureSkipTlsVerify: 'true',
    })
    // Secrets are never surfaced back as prefill values.
    expect(values).not.toHaveProperty(EKS_ACCESS_KEY_ID_SECRET_KEY)
  })

  it('ignores a foreign config (routing is by kind)', () => {
    expect(form.valuesFromConfig({ kind: 'manifest' } as RunnerBackendConfig)).toEqual({})
  })
})

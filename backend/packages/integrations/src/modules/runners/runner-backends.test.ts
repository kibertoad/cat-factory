import type { RunnerBackendConfig, RunnerPoolManifest } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { KubernetesRunnerTransport } from '../kubernetes/KubernetesRunnerTransport.js'
import { RunnerPoolTransport } from './RunnerPoolTransport.js'
import { registeredRunnerBackendKinds, runnerBackend } from './runner-backends.js'

const manifest: RunnerPoolManifest = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://acme.test/api',
  auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
  dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
  poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
  response: { statusPath: 'state' },
}

describe('runner-backend registry', () => {
  it('registers both built-in backend kinds', () => {
    expect(registeredRunnerBackendKinds().sort()).toEqual(['kubernetes', 'manifest'])
  })

  it('builds a RunnerPoolTransport for the manifest kind', () => {
    const config: RunnerBackendConfig = { kind: 'manifest', manifest }
    const provider = runnerBackend('manifest')!
    expect(provider.referencedSecretKeys(config)).toEqual(['API_TOKEN'])
    expect(provider.connectionMeta(config)).toEqual({
      providerId: 'acme',
      label: 'Acme',
      baseUrl: 'https://acme.test/api',
    })
    const transport = provider.buildTransport(config, { resolveSecret: () => 'tok' })
    expect(transport).toBeInstanceOf(RunnerPoolTransport)
  })

  it('builds a KubernetesRunnerTransport for the kubernetes kind', () => {
    const config: RunnerBackendConfig = {
      kind: 'kubernetes',
      kubernetes: {
        label: 'Prod',
        apiServerUrl: 'https://k8s.example:6443',
        namespace: 'cat-factory',
        image: 'ghcr.io/acme/executor:1',
      },
    }
    const provider = runnerBackend('kubernetes')!
    expect(provider.referencedSecretKeys(config)).toEqual(['apiToken'])
    expect(provider.connectionMeta(config)).toEqual({
      providerId: 'kubernetes',
      label: 'Prod',
      baseUrl: 'https://k8s.example:6443',
    })
    const transport = provider.buildTransport(config, { resolveSecret: () => 'tok' })
    expect(transport).toBeInstanceOf(KubernetesRunnerTransport)
  })

  it('rejects an unsafe apiserver URL at the write boundary', () => {
    const config: RunnerBackendConfig = {
      kind: 'kubernetes',
      kubernetes: {
        label: 'Bad',
        apiServerUrl: 'http://k8s.example:6443',
        namespace: 'cat-factory',
        image: 'img',
      },
    }
    expect(() => runnerBackend('kubernetes')!.assertConfigSafe(config)).toThrow(/https/)
  })
})

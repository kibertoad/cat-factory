import type { KubernetesRunnerConfig } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  assertApiServerUrlSafe,
  buildPodManifest,
  classifyPodReadiness,
  podName,
  proxyUrl,
  resolveImage,
  resolveResources,
} from './kubernetes.logic.js'

const config: KubernetesRunnerConfig = {
  label: 'Test',
  apiServerUrl: 'https://k8s.example:6443',
  namespace: 'cat-factory',
  image: 'ghcr.io/acme/executor:1.0.0',
}

describe('podName', () => {
  it('derives a deterministic RFC1123 pod name from a run id', () => {
    expect(podName('Run_ABC-123')).toBe('cf-run-run-abc-123')
  })
  it('truncates to fit the 63-char label limit', () => {
    const name = podName('x'.repeat(100))
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name.startsWith('cf-run-')).toBe(true)
  })
})

describe('proxyUrl', () => {
  it('targets the apiserver pod-proxy subresource with the harness port', () => {
    expect(proxyUrl(config, 'cf-run-1', '/jobs/abc')).toBe(
      'https://k8s.example:6443/api/v1/namespaces/cat-factory/pods/cf-run-1%3A8080/proxy/jobs/abc',
    )
  })
  it('honours a custom harness port', () => {
    expect(proxyUrl({ ...config, harnessPort: 9000 }, 'p', '/jobs')).toContain(
      'p%3A9000/proxy/jobs',
    )
  })
})

describe('classifyPodReadiness', () => {
  it('is ready when Running with a true Ready condition', () => {
    expect(
      classifyPodReadiness({
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      }),
    ).toBe('ready')
  })
  it('is pending while Running but not yet Ready', () => {
    expect(
      classifyPodReadiness({
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] },
      }),
    ).toBe('pending')
  })
  it('is gone on a terminal phase', () => {
    expect(classifyPodReadiness({ status: { phase: 'Failed' } })).toBe('gone')
    expect(classifyPodReadiness({ status: { phase: 'Succeeded' } })).toBe('gone')
  })
  it('is pending while still Pending', () => {
    expect(classifyPodReadiness({ status: { phase: 'Pending' } })).toBe('pending')
  })
})

describe('assertApiServerUrlSafe', () => {
  it('accepts a private cluster apiserver (unlike the strict manifest policy)', () => {
    expect(() => assertApiServerUrlSafe('https://10.0.0.1:6443')).not.toThrow()
    expect(() => assertApiServerUrlSafe('https://kubernetes.default.svc')).not.toThrow()
  })
  it('requires https', () => {
    expect(() => assertApiServerUrlSafe('http://k8s.example:6443')).toThrow(/https/)
  })
  it('rejects the cloud metadata endpoint', () => {
    expect(() => assertApiServerUrlSafe('https://169.254.169.254')).toThrow(/metadata/)
  })
})

describe('resolveImage / resolveResources', () => {
  it('uses the UI image only when asked and configured', () => {
    expect(resolveImage(config)).toBe(config.image)
    expect(resolveImage(config, { image: 'ui' })).toBe(config.image)
    expect(resolveImage({ ...config, imageUi: 'ui-img' }, { image: 'ui' })).toBe('ui-img')
  })
  it('prefers a per-size limit override over the default', () => {
    const sized: KubernetesRunnerConfig = {
      ...config,
      resources: { requests: { cpu: '1' }, limits: { cpu: '2' } },
      resourcesBySize: { large: { cpu: '8', memory: '16Gi' } },
    }
    expect(resolveResources(sized, { instanceSize: 'large' })?.limits).toEqual({
      cpu: '8',
      memory: '16Gi',
    })
    expect(resolveResources(sized)?.limits).toEqual({ cpu: '2' })
  })
})

describe('buildPodManifest', () => {
  it('builds a bare Pod with the run label, harness port and image', () => {
    const pod = buildPodManifest(config, 'run-1', 'cf-run-1') as {
      kind: string
      metadata: { name: string; labels: Record<string, string> }
      spec: { restartPolicy: string; containers: Array<Record<string, unknown>> }
    }
    expect(pod.kind).toBe('Pod')
    expect(pod.metadata.name).toBe('cf-run-1')
    expect(pod.metadata.labels['cat-factory.runId']).toBe('run-1')
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.containers[0]!.image).toBe(config.image)
    expect(pod.spec.containers[0]!.ports).toEqual([{ containerPort: 8080 }])
  })
})

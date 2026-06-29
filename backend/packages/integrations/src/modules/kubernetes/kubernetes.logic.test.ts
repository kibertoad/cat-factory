import type { KubernetesRunnerConfig } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  assertApiServerUrlSafe,
  buildPodManifest,
  classifyPodReadiness,
  classifyPodStartupFailure,
  describePodStatus,
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
  it('targets the apiserver pod-proxy subresource with a LITERAL name:port colon', () => {
    expect(proxyUrl(config, 'cf-run-1', '/jobs/abc')).toBe(
      'https://k8s.example:6443/api/v1/namespaces/cat-factory/pods/cf-run-1:8080/proxy/jobs/abc',
    )
  })
  it('honours a custom harness port', () => {
    expect(proxyUrl({ ...config, harnessPort: 9000 }, 'p', '/jobs')).toContain('p:9000/proxy/jobs')
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

describe('classifyPodStartupFailure', () => {
  const waiting = (reason: string, message?: string) => ({
    status: {
      phase: 'Pending',
      containerStatuses: [{ name: 'executor', state: { waiting: { reason, message } } }],
    },
  })

  it('flags terminal, unrecoverable container-waiting reasons with their message', () => {
    expect(
      classifyPodStartupFailure(waiting('ImagePullBackOff', 'Back-off pulling image "x"')),
    ).toBe('ImagePullBackOff: Back-off pulling image "x"')
    expect(classifyPodStartupFailure(waiting('CrashLoopBackOff'))).toBe('CrashLoopBackOff')
    expect(classifyPodStartupFailure(waiting('InvalidImageName', 'bad ref'))).toBe(
      'InvalidImageName: bad ref',
    )
    expect(classifyPodStartupFailure(waiting('CreateContainerConfigError', 'secret missing'))).toBe(
      'CreateContainerConfigError: secret missing',
    )
    // A failed lifecycle hook / image-inspect error is just as terminal as a bad image.
    expect(classifyPodStartupFailure(waiting('PreStartHookError', 'hook exited 1'))).toBe(
      'PreStartHookError: hook exited 1',
    )
    expect(classifyPodStartupFailure(waiting('ImageInspectError'))).toBe('ImageInspectError')
  })

  it('returns null for the normal transient waiting reasons (still coming up)', () => {
    expect(classifyPodStartupFailure(waiting('ContainerCreating'))).toBeNull()
    expect(classifyPodStartupFailure(waiting('PodInitializing'))).toBeNull()
    expect(classifyPodStartupFailure({ status: { phase: 'Pending' } })).toBeNull()
    expect(classifyPodStartupFailure(null)).toBeNull()
  })
})

describe('describePodStatus', () => {
  it('surfaces a waiting container reason:message', () => {
    expect(
      describePodStatus({
        status: {
          containerStatuses: [
            { state: { waiting: { reason: 'ContainerCreating', message: 'pulling' } } },
          ],
        },
      }),
    ).toBe('ContainerCreating: pulling')
  })
  it('falls back to a failed pod condition message', () => {
    expect(
      describePodStatus({
        status: {
          phase: 'Pending',
          conditions: [
            { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'no nodes' },
          ],
        },
      }),
    ).toBe('Unschedulable: no nodes')
  })
  it('returns empty string when nothing useful is present', () => {
    expect(describePodStatus({ status: { phase: 'Running' } })).toBe('')
    expect(describePodStatus(null)).toBe('')
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
  it('rejects the cloud metadata endpoint, including obfuscated encodings', () => {
    expect(() => assertApiServerUrlSafe('https://169.254.169.254')).toThrow(/metadata/)
    // Anywhere in the link-local range, the Alibaba metadata IP, the AWS IPv6 IMDS, the
    // bare-integer and IPv4-mapped-IPv6 encodings of 169.254.169.254.
    expect(() => assertApiServerUrlSafe('https://169.254.10.20')).toThrow(/metadata/)
    expect(() => assertApiServerUrlSafe('https://100.100.100.200')).toThrow(/metadata/)
    expect(() => assertApiServerUrlSafe('https://[fd00:ec2::254]')).toThrow(/metadata/)
    expect(() => assertApiServerUrlSafe('https://2852039166')).toThrow(/metadata/)
    expect(() => assertApiServerUrlSafe('https://[::ffff:169.254.169.254]')).toThrow(/metadata/)
  })
})

describe('resolveImage / resolveResources', () => {
  it('uses the UI image only when asked and configured', () => {
    expect(resolveImage(config)).toBe(config.image)
    expect(resolveImage(config, { image: 'ui' })).toBe(config.image)
    expect(resolveImage({ ...config, imageUi: 'ui-img' }, { image: 'ui' })).toBe('ui-img')
  })
  it('prefers a per-size override over the default for BOTH requests and limits', () => {
    const sized: KubernetesRunnerConfig = {
      ...config,
      resources: { requests: { cpu: '1' }, limits: { cpu: '2' } },
      resourcesBySize: { large: { cpu: '8', memory: '16Gi' } },
    }
    const resolved = resolveResources(sized, { instanceSize: 'large' })
    expect(resolved?.limits).toEqual({ cpu: '8', memory: '16Gi' })
    // The override drives requests too (requests == limits), so requests can't exceed
    // the sized limit — the apiserver would 422 on requests > limits otherwise.
    expect(resolved?.requests).toEqual({ cpu: '8', memory: '16Gi' })
    expect(resolveResources(sized)?.limits).toEqual({ cpu: '2' })
    expect(resolveResources(sized)?.requests).toEqual({ cpu: '1' })
  })

  it('keeps a smaller size from leaving the default request above the sized limit', () => {
    const sized: KubernetesRunnerConfig = {
      ...config,
      resources: { requests: { memory: '1Gi' }, limits: { memory: '4Gi' } },
      resourcesBySize: { small: { memory: '256Mi' } },
    }
    const resolved = resolveResources(sized, { instanceSize: 'small' })
    expect(resolved?.requests).toEqual({ memory: '256Mi' })
    expect(resolved?.limits).toEqual({ memory: '256Mi' })
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

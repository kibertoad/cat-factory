import type { KubernetesRunnerConfig } from '@cat-factory/kernel'
import { containerKeyForRef } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  apiServerConnectionFailureMessage,
  assertApiServerUrlSafe,
  buildPodManifest,
  classifyPodReadiness,
  classifyPodStartupFailure,
  describePodStatus,
  describePodTermination,
  podExitedCleanly,
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

  it('gives a VARIANT its own pod, so a later step cannot re-attach to the wrong image', () => {
    // It takes the container KEY, not the run id: a run's second `ensurePod` 409s and re-attaches
    // by design, which is right for two steps that want the same image and silently wrong for two
    // that do not. Keyed on the run alone, a `tester-ui` step landed in the pod an earlier coder
    // step created on the base image, and Playwright was simply absent.
    expect(podName(containerKeyForRef({ runId: 'exec_1', jobId: 'j' }))).toBe('cf-run-exec-1')
    expect(podName(containerKeyForRef({ runId: 'exec_1', jobId: 'j', image: 'ui' }))).toBe(
      'cf-run-ui-exec-1',
    )
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

describe('describePodTermination', () => {
  it('names the container, its reason and its exit code', () => {
    expect(
      describePodTermination({
        status: {
          phase: 'Failed',
          containerStatuses: [
            { name: 'executor', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } },
          ],
        },
      }),
    ).toBe("Container 'executor' terminated: OOMKilled, exit code 137")
  })

  it('falls back to the PREVIOUS incarnation for a container between lives', () => {
    // A container waiting to restart has no `state.terminated`; the cause of the crash loop is
    // in `lastState`, which is the field the transport never read (finding D1).
    expect(
      describePodTermination({
        status: {
          containerStatuses: [
            {
              name: 'executor',
              state: { waiting: { reason: 'CrashLoopBackOff' } },
              lastState: { terminated: { exitCode: 1, message: 'harness boot failed' } },
            },
          ],
        },
      }),
    ).toBe("Container 'executor' terminated: exit code 1 (harness boot failed)")
  })

  it('adds the pod-level reason, which no container status reports', () => {
    // A kubelet eviction under node pressure takes the pod away without the container ever
    // seeing it, so this line is ADDITIONAL to the container's own account, not a substitute.
    const described = describePodTermination({
      status: {
        phase: 'Failed',
        reason: 'Evicted',
        message: 'The node was low on resource: memory.',
        containerStatuses: [
          { name: 'executor', state: { terminated: { reason: 'Error', exitCode: 137 } } },
        ],
      },
    })

    expect(described).toContain("Container 'executor' terminated")
    expect(described).toContain('Pod Evicted: The node was low on resource: memory.')
  })

  it("reports the kubelet's prose when it came with no machine-readable reason", () => {
    // The apiserver does not guarantee `reason` beside `message`, and the message is the
    // evidence: a preemption notice, a disk-pressure eviction. Gating the prose on the code
    // renders an evidence-carrying pod as an EMPTY detail, which is indistinguishable from a pod
    // that vanished saying nothing at all, and the transport reports those two differently on purpose.
    expect(
      describePodTermination({
        status: { phase: 'Failed', message: 'Pod was preempted by a higher-priority pod.' },
      }),
    ).toBe('Pod reports: Pod was preempted by a higher-priority pod.')
  })

  it('returns empty string when the status says nothing about a termination', () => {
    expect(describePodTermination({ status: { phase: 'Running' } })).toBe('')
    expect(describePodTermination(null)).toBe('')
    // A blank message is nothing said, not an account: reporting it verbatim would announce a
    // pod-level explanation and then give none.
    expect(describePodTermination({ status: { phase: 'Failed', message: '   ' } })).toBe('')
  })
})

describe('podExitedCleanly', () => {
  // The distinction the local and Cloudflare transports already draw, read off the one field a
  // pod exposes it in. A runner pod's only workload is the harness, so a container that ended 0
  // with the job still in flight is a harness something STOPPED: the engine fails that run at
  // once instead of spending its crash budget re-running the agent into whatever stopped it.
  it('reads a clean exit as the harness having been shut down', () => {
    expect(
      podExitedCleanly({
        status: {
          phase: 'Succeeded',
          containerStatuses: [
            { name: 'executor', state: { terminated: { reason: 'Completed', exitCode: 0 } } },
          ],
        },
      }),
    ).toBe(true)
  })

  it('refuses a non-zero exit and a signal death alike', () => {
    expect(
      podExitedCleanly({
        status: { containerStatuses: [{ state: { terminated: { exitCode: 137 } } }] },
      }),
    ).toBe(false)
    // Exit code 0 WITH a signal is the kubelet killing a container that was mid-shutdown; the
    // zero is then an artefact of how it died, not an account of it leaving.
    expect(
      podExitedCleanly({
        status: { containerStatuses: [{ state: { terminated: { exitCode: 0, signal: 15 } } }] },
      }),
    ).toBe(false)
  })

  it('lets the kubelet overrule the container: a pod TAKEN AWAY is an eviction', () => {
    // A pod-level reason is the kubelet's own account of removing the pod, which no container
    // status reports. Whatever the workload managed to exit with on the way out, this is a loss
    // the engine should answer with a fresh pod rather than by failing the run.
    expect(
      podExitedCleanly({
        status: {
          phase: 'Failed',
          reason: 'Evicted',
          containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
        },
      }),
    ).toBe(false)
  })

  it('answers false when nothing terminated, so an unreadable pod is never a shutdown', () => {
    // Absent is not zero: a pod already deleted or garbage-collected, or one still running,
    // says nothing about how the workload ended and must stay an eviction.
    expect(podExitedCleanly({ status: { phase: 'Running' } })).toBe(false)
    expect(podExitedCleanly(null)).toBe(false)
    // A previous incarnation's clean exit is not this one's: `lastState` is deliberately unread.
    expect(
      podExitedCleanly({
        status: {
          containerStatuses: [
            {
              state: { waiting: { reason: 'CrashLoopBackOff' } },
              lastState: { terminated: { exitCode: 0 } },
            },
          ],
        },
      }),
    ).toBe(false)
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
    expect(resolveImage({ ...config, imageUi: 'ui-img' }, { image: 'ui' })).toBe('ui-img')
  })
  // The pool used to fall back to the plain executor image here. Nothing downstream notices:
  // the browser-driven tester runs happily until it needs a browser, which is after the
  // checkout, the install and the model's first turns, and reports an `abort` that reads like
  // an app which would not boot. The refusal is the only signal that names the real cause.
  it('refuses a ui dispatch when no UI image is configured, rather than serving the default', () => {
    expect(() => resolveImage(config, { image: 'ui' })).toThrow(/imageUi/)
  })
  // The deploy variant keeps its fallback on purpose: the deploy harness preflights for its own
  // CLIs and fails loudly naming them, so the pod reaching the executor image is already
  // reported. Pinned so the two are not "harmonised" into one rule by a later reader.
  it('still falls back to the default image for an unconfigured deploy variant', () => {
    expect(resolveImage(config, { image: 'deploy' })).toBe(config.image)
  })

  it("serves a DEPLOYMENT's own variant from the image map", () => {
    const withVariant = { ...config, imageVariants: { 'pixel-tools': 'ghcr.io/acme/pixel:2' } }
    expect(resolveImage(withVariant, { image: 'pixel-tools' })).toBe('ghcr.io/acme/pixel:2')
    // The platform's own names keep their own settings: a map entry cannot repoint them, and the
    // schema refuses one, so this only pins that the lookup does not reach for them either.
    expect(resolveImage(withVariant, { image: 'default' })).toBe(config.image)
  })

  it('refuses an unmapped deployment variant, where `deploy` falls back', () => {
    // The opposite disposition from the `deploy` case above, and deliberately: the platform knows
    // what the deploy image carries, so the harness's own preflight reports the missing CLIs.
    // Nothing here knows what `pixel-tools` carried, so running the default would produce a job
    // silently missing it and a step reporting no cause.
    expect(() => resolveImage(config, { image: 'pixel-tools' })).toThrow(/pixel-tools/)
    expect(() => resolveImage(config, { image: 'pixel-tools' })).toThrow(/imageVariants/)
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
    // The readiness probe gates the pod's `Ready` condition on the harness actually serving.
    expect(pod.spec.containers[0]!.readinessProbe).toMatchObject({
      httpGet: { path: '/health', port: 8080 },
    })
  })
})

describe('apiServerConnectionFailureMessage', () => {
  const body = '{"kind":"Status","message":"Unauthorized","code":401}'

  it('explains a 401 as an auth failure with an actionable mint-a-fresh-token fix', () => {
    const msg = apiServerConnectionFailureMessage(401, body, { operation: 'list pods' })
    expect(msg).toContain('401')
    expect(msg).toMatch(/expired|no longer recognised/i)
    // It must NOT frame a 401 as an RBAC problem (that's a 403).
    expect(msg).not.toMatch(/RBAC to list pods/i)
    // Actionable: names the causes (short-lived token / recreated cluster) and the fix.
    expect(msg).toMatch(/kubectl create token/)
    expect(msg).toMatch(/recreated|rotates/i)
    // Does NOT dump the raw apiserver Status body for the auth verdicts.
    expect(msg).not.toContain('"kind":"Status"')
  })

  it('substitutes the namespace into the 401 fix command when provided', () => {
    const msg = apiServerConnectionFailureMessage(401, body, {
      operation: 'list pods',
      namespace: 'cat-factory',
    })
    expect(msg).toContain('-n cat-factory')
  })

  it('explains a 403 as an RBAC denial naming the attempted operation', () => {
    const msg = apiServerConnectionFailureMessage(403, 'forbidden', {
      operation: 'list namespaces',
    })
    expect(msg).toContain('403')
    expect(msg).toMatch(/not allowed to list namespaces/i)
    expect(msg).toMatch(/Role|ClusterRole/)
  })

  it('keeps the raw status:body shape for any other status', () => {
    expect(apiServerConnectionFailureMessage(500, 'boom', { operation: 'list pods' })).toBe(
      'apiserver responded 500: boom',
    )
  })
})

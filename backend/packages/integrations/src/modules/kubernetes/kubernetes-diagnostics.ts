import type {
  EnvironmentDiagnosis,
  EnvironmentDiagnosticFact,
  EnvironmentDiagnosticGap,
  EnvironmentDiagnosticLog,
  EnvironmentRemediationOutcome,
  KubernetesConnectionConfig,
  ProviderRemediationAction,
} from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'
import type { KubernetesApiClient } from './KubernetesApiClient.js'
import { safeText } from './KubernetesApiClient.js'
import { analyzePodStatus, apiBase, describeDeploymentRollout } from './kubernetes.logic.js'
import { namespaceUrl, resourceUrl } from './kubernetes-environment.logic.js'

// ---------------------------------------------------------------------------
// The Kubernetes environment backend's DIAGNOSTICS: what the apiserver can say about a namespace
// that never became usable, and the one thing the platform can ask it to do about it.
//
// `status()` reduces the whole cluster's answer to one word because that is what a readiness
// judgement needs, and everything else is dropped, including the per-pod terminal reasons
// `analyzePodStatus` has always been able to extract (it is what the runner transport reads for
// executor pods). This is where those reach a reader: an `ImagePullBackOff` or a `CrashLoopBackOff`
// arrives at the run as a generic timeout today, and the difference between "the image does not
// exist" and "we waited twenty minutes" is the entire diagnosis.
//
// Every read is INDEPENDENT and every failure is NAMED. A namespace read that 403s and a namespace
// that is genuinely empty produce very different diagnoses, and an investigation shown only the
// second concludes the workload was never applied.
// ---------------------------------------------------------------------------

/** Read timeout for one diagnostic call. Shorter than a provision's: this runs after a failure. */
const DIAGNOSTIC_TIMEOUT_MS = 15_000

/** Log lines pulled from one container. Enough to carry a stack trace and a crash banner. */
const LOG_TAIL_LINES = 120

/** How many unhealthy pods get their logs read. A crash-looping ReplicaSet repeats one cause. */
const LOG_POD_LIMIT = 3

/** Warning events kept. The apiserver returns them unordered, so this is a cap, not a window. */
const EVENT_LIMIT = 20

/**
 * The annotation a restart stamps, mirroring what `kubectl rollout restart` writes. A pod-template
 * change is what makes a Deployment roll: there is no "restart" verb on the apiserver, and deleting
 * the pods instead would race the ReplicaSet controller and skip any Deployment whose rollout is
 * itself wedged.
 */
const RESTART_ANNOTATION = 'cat-factory.ai/restartedAt'

/** The remediations this backend performs. Declared, so the engine never offers what it cannot do. */
export const KUBERNETES_REMEDIATIONS: readonly ProviderRemediationAction[] = ['restart']

interface DiagnosisAccumulator {
  facts: EnvironmentDiagnosticFact[]
  logs: EnvironmentDiagnosticLog[]
  gaps: EnvironmentDiagnosticGap[]
}

/**
 * Read everything the apiserver will say about this environment's namespace.
 *
 * Never throws: a diagnosis assembled from three of four reads is strictly better than none, and
 * this runs on a path where the run has already failed. What it will not do is stay silent about
 * a read it could not make: each becomes a `gap`, with `permanent` set for the answers that will
 * never change (an RBAC refusal will refuse identically forever; a 503 will not).
 */
export async function describeKubernetesEnvironment(args: {
  client: KubernetesApiClient
  config: KubernetesConnectionConfig
  namespace: string
}): Promise<EnvironmentDiagnosis> {
  const acc: DiagnosisAccumulator = { facts: [], logs: [], gaps: [] }
  acc.facts.push({ key: 'namespace', value: args.namespace })
  await readNamespace(args, acc)
  await readDeployments(args, acc)
  const unhealthy = await readPods(args, acc)
  await readEvents(args, acc)
  await readLogs(args, unhealthy, acc)
  return {
    facts: acc.facts,
    ...(acc.logs.length > 0 ? { logs: acc.logs } : {}),
    ...(acc.gaps.length > 0 ? { gaps: acc.gaps } : {}),
  }
}

/**
 * Roll every Deployment in the namespace, the `kubectl rollout restart` way.
 *
 * `applied: false` when there is nothing to roll, because a namespace with no Deployments has not
 * been restarted and reporting otherwise would have the engine re-probe an untouched environment
 * and read the unchanged verdict as a remedy that did not work. A patch that FAILS throws, so the
 * engine reports the refusal rather than waiting on a rollout nobody started.
 */
export async function restartKubernetesWorkloads(args: {
  client: KubernetesApiClient
  config: KubernetesConnectionConfig
  namespace: string
}): Promise<EnvironmentRemediationOutcome> {
  const { client, config, namespace } = args
  const names = await listDeploymentNames(client, config, namespace)
  if (names.length === 0) {
    return { applied: false, detail: `namespace '${namespace}' declares no Deployment to restart` }
  }
  const stamp = new Date().toISOString()
  for (const name of names) {
    const res = await client.fetch(
      'PATCH',
      resourceUrl(config, 'apps/v1', 'Deployment', namespace, name),
      { spec: { template: { metadata: { annotations: { [RESTART_ANNOTATION]: stamp } } } } },
      DIAGNOSTIC_TIMEOUT_MS,
      'application/strategic-merge-patch+json',
    )
    if (!res.ok) {
      throw new Error(
        `Failed to restart Deployment/${name} in '${namespace}' (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }
  return {
    applied: true,
    detail: `rolled ${names.length} Deployment(s) in '${namespace}' by stamping ${RESTART_ANNOTATION}`,
  }
}

async function listDeploymentNames(
  client: KubernetesApiClient,
  config: KubernetesConnectionConfig,
  namespace: string,
): Promise<string[]> {
  const res = await client.fetch(
    'GET',
    resourceUrl(config, 'apps/v1', 'Deployment', namespace),
    undefined,
    DIAGNOSTIC_TIMEOUT_MS,
  )
  if (!res.ok) {
    throw new Error(
      `Could not list Deployments in '${namespace}' (HTTP ${res.status}): ${await safeText(res)}`,
    )
  }
  const body = (await res.json()) as { items?: unknown[] }
  return (Array.isArray(body.items) ? body.items : [])
    .map((item) => metaName(item))
    .filter((name): name is string => !!name)
}

async function readNamespace(
  args: { client: KubernetesApiClient; config: KubernetesConnectionConfig; namespace: string },
  acc: DiagnosisAccumulator,
): Promise<void> {
  await attempt(acc, 'namespace', async () => {
    const res = await args.client.fetch(
      'GET',
      namespaceUrl(args.config, args.namespace),
      undefined,
      DIAGNOSTIC_TIMEOUT_MS,
    )
    if (res.status === 404) {
      acc.facts.push({ key: 'namespace.exists', value: 'false', healthy: false })
      return
    }
    if (!res.ok) throw new HttpReadError(res.status, await safeText(res))
    const body = (await res.json()) as { status?: { phase?: unknown } }
    const phase = typeof body.status?.phase === 'string' ? body.status.phase : 'unknown'
    acc.facts.push({ key: 'namespace.exists', value: 'true' })
    // `Terminating` is the fact that most often explains a namespace whose workloads will not
    // come up: something is tearing it down under the run, and nothing applied into it will stay.
    acc.facts.push({ key: 'namespace.phase', value: phase, healthy: phase === 'Active' })
  })
}

async function readDeployments(
  args: { client: KubernetesApiClient; config: KubernetesConnectionConfig; namespace: string },
  acc: DiagnosisAccumulator,
): Promise<void> {
  await attempt(acc, 'deployments', async () => {
    const res = await args.client.fetch(
      'GET',
      resourceUrl(args.config, 'apps/v1', 'Deployment', args.namespace),
      undefined,
      DIAGNOSTIC_TIMEOUT_MS,
    )
    if (!res.ok) throw new HttpReadError(res.status, await safeText(res))
    const body = (await res.json()) as { items?: unknown[] }
    const items = Array.isArray(body.items) ? body.items : []
    acc.facts.push({ key: 'deployments.count', value: String(items.length) })
    for (const item of items) {
      const name = metaName(item) ?? '(unnamed)'
      // The DIAGNOSTIC reader, not the lifecycle one: a diagnosis is a table of per-object facts
      // the investigator reconciles, which is what `reduceRolloutProgress` reduces away on purpose.
      const rollout = describeDeploymentRollout(item)
      acc.facts.push({
        key: `deployments.${name}.readiness`,
        value: rollout.readiness,
        healthy: rollout.readiness === 'ready',
      })
      acc.facts.push({
        key: `deployments.${name}.replicas`,
        value: `${rollout.ready}/${rollout.desired} desired ready`,
        healthy: rollout.ready >= rollout.desired,
      })
      const status = (item as { status?: Record<string, unknown> }).status ?? {}
      for (const condition of conditionsOf(status)) {
        // Only the conditions that are NOT satisfied: a Deployment carries `Available=True` on
        // every healthy object, and listing those buries the one that says why it is stuck.
        if (condition.status === 'True') continue
        acc.facts.push({
          key: `deployments.${name}.condition.${condition.type}`,
          value: `${condition.status}${condition.reason ? ` (${condition.reason})` : ''}${
            condition.message ? `: ${condition.message}` : ''
          }`,
          healthy: false,
        })
      }
    }
  })
}

/** Reads every pod, records what is wrong with each, and returns the ones worth reading logs from. */
async function readPods(
  args: { client: KubernetesApiClient; config: KubernetesConnectionConfig; namespace: string },
  acc: DiagnosisAccumulator,
): Promise<{ pod: string; container?: string }[]> {
  const unhealthy: { pod: string; container?: string }[] = []
  await attempt(acc, 'pods', async () => {
    const res = await args.client.fetch(
      'GET',
      resourceUrl(args.config, 'v1', 'Pod', args.namespace),
      undefined,
      DIAGNOSTIC_TIMEOUT_MS,
    )
    if (!res.ok) throw new HttpReadError(res.status, await safeText(res))
    const body = (await res.json()) as { items?: unknown[] }
    const items = Array.isArray(body.items) ? body.items : []
    acc.facts.push({ key: 'pods.count', value: String(items.length) })
    for (const item of items) {
      const name = metaName(item) ?? '(unnamed)'
      // The PHASE first, unconditionally. It is the single most diagnostic field on a pod and it
      // is the one `analyzePodStatus` cannot give: that walk reads container statuses, and an
      // unschedulable pod has none, so `Pending` with a `PodScheduled=False` condition used to
      // reach the bundle as an empty string and nothing else.
      const phase = podPhase(item)
      acc.facts.push({
        key: `pods.${name}.phase`,
        value: phase,
        // No verdict on a `Running` pod: readiness is the next fact's job, and a phase alone
        // cannot say a workload is healthy. Anything else IS a finding.
        ...(phase === 'Running' ? {} : { healthy: false }),
      })
      // The walk the runner transport has always done for executor pods, reused verbatim: it is
      // what turns `phase: Pending` into `ImagePullBackOff` with the image named.
      const analysis = analyzePodStatus(item)
      acc.facts.push({
        key: `pods.${name}.status`,
        // Its own words when there are none, never ''. An empty value renders as a fact that
        // announces an account and gives none, and the reader cannot tell it from a read that
        // came back clean.
        value: analysis.detail || unreadyConditionOf(item) || 'the pod reports no reason',
        healthy: analysis.terminal === null ? undefined : false,
      })
      if (analysis.terminal) {
        acc.facts.push({
          key: `pods.${name}.terminalReason`,
          value: analysis.terminal,
          healthy: false,
        })
      }
      if (analysis.terminal || !isPodReady(item)) {
        unhealthy.push({ pod: name, ...firstContainerName(item) })
      }
    }
  })
  return unhealthy
}

async function readEvents(
  args: { client: KubernetesApiClient; config: KubernetesConnectionConfig; namespace: string },
  acc: DiagnosisAccumulator,
): Promise<void> {
  await attempt(acc, 'warning events', async () => {
    // Built here rather than through `resourceUrl`, for the reason `ingressClassesUrl` is: that
    // helper reads the ALLOW-LIST of kinds a repository's manifests may have applied on its
    // behalf, and adding `Event` to it to reach one read would widen what a checkout can apply.
    const url =
      `${apiBase(args.config)}/api/v1/namespaces/${encodeURIComponent(args.namespace)}/events` +
      '?fieldSelector=type%3DWarning'
    const res = await args.client.fetch('GET', url, undefined, DIAGNOSTIC_TIMEOUT_MS)
    if (!res.ok) throw new HttpReadError(res.status, await safeText(res))
    const body = (await res.json()) as { items?: unknown[] }
    const all = Array.isArray(body.items) ? body.items : []
    const items = all.slice(0, EVENT_LIMIT)
    // The count is of what the apiserver RETURNED, taken before the cap: reporting the capped
    // length states the cap and reads as the real number, and a namespace with 200 `FailedScheduling`
    // events then looks like one with 20.
    acc.facts.push({ key: 'events.warnings', value: String(all.length), healthy: all.length === 0 })
    if (all.length > items.length) {
      acc.facts.push({
        key: 'events.listed',
        value:
          `${items.length} of ${all.length}; the apiserver returns warning events unordered, so ` +
          `the ${all.length - items.length} not listed are an arbitrary subset, not the oldest`,
      })
    }
    for (const [index, item] of items.entries()) {
      const event = item as { reason?: unknown; message?: unknown; count?: unknown }
      acc.facts.push({
        key: `events[${index}]`,
        value: `${String(event.reason ?? 'Warning')}: ${String(event.message ?? '')}${
          numberOr(event.count, 1) > 1 ? ` (x${numberOr(event.count, 1)})` : ''
        }`,
        healthy: false,
      })
    }
  })
}

async function readLogs(
  args: { client: KubernetesApiClient; config: KubernetesConnectionConfig; namespace: string },
  unhealthy: { pod: string; container?: string }[],
  acc: DiagnosisAccumulator,
): Promise<void> {
  if (unhealthy.length === 0) return
  for (const target of unhealthy.slice(0, LOG_POD_LIMIT)) {
    await attempt(acc, `logs of pod ${target.pod}`, async () => {
      // ONE line more than we intend to keep, so the answer says whether there WAS a start to
      // drop. `tailLines` is line-based, so a response of exactly the probe size means the log had
      // at least that many lines and the excerpt genuinely is a tail; anything shorter is the
      // whole log, and marking that one truncated tells the investigator the start was hidden
      // when it is right there (which the role prompt's DISTRUST ABSENCE directive then acts on).
      const query = new URLSearchParams({ tailLines: String(LOG_TAIL_LINES + 1) })
      if (target.container) query.set('container', target.container)
      const url =
        `${apiBase(args.config)}/api/v1/namespaces/${encodeURIComponent(args.namespace)}` +
        `/pods/${encodeURIComponent(target.pod)}/log?${query.toString()}`
      const res = await args.client.fetch('GET', url, undefined, DIAGNOSTIC_TIMEOUT_MS)
      if (!res.ok) throw new HttpReadError(res.status, await safeText(res))
      const text = (await res.text()).trim()
      if (!text) {
        // An empty log is a FACT, and a useful one: a container that produced nothing before dying
        // usually never started its process at all.
        acc.facts.push({
          key: `pods.${target.pod}.log`,
          value: 'the container produced no output',
          healthy: false,
        })
        return
      }
      const lines = text.split('\n')
      const truncated = lines.length > LOG_TAIL_LINES
      acc.logs.push({
        source: `pod/${target.pod}`,
        text: truncated ? lines.slice(lines.length - LOG_TAIL_LINES).join('\n') : text,
        ...(truncated ? { truncated: true } : {}),
      })
    })
  }
}

/** An apiserver read that answered, unhappily. Carries the status so `permanent` can be decided. */
class HttpReadError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`)
  }
}

/**
 * Run one read, turning any failure into a NAMED gap rather than losing the whole diagnosis.
 *
 * `permanent` is the split that matters to whoever reads the result: an RBAC refusal (401/403) or
 * an endpoint this cluster does not serve (404 on a collection) answers identically forever and is
 * only ever fixed by a human widening the ServiceAccount, while a 503 or a timeout is worth
 * re-asking. Reported as one gap either way, never as an absence.
 */
async function attempt(
  acc: DiagnosisAccumulator,
  read: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const status = error instanceof HttpReadError ? error.status : undefined
    acc.gaps.push({
      read,
      reason: getErrorMessage(error),
      ...(status === 401 || status === 403 || status === 404 ? { permanent: true } : {}),
    })
  }
}

function metaName(item: unknown): string | undefined {
  const name = (item as { metadata?: { name?: unknown } })?.metadata?.name
  return typeof name === 'string' ? name : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function conditionsOf(
  status: Record<string, unknown>,
): { type: string; status: string; reason?: string; message?: string }[] {
  const raw = Array.isArray(status.conditions) ? status.conditions : []
  return raw.map((entry) => {
    const condition = (entry ?? {}) as Record<string, unknown>
    return {
      type: String(condition.type ?? 'Unknown'),
      status: String(condition.status ?? 'Unknown'),
      ...(typeof condition.reason === 'string' ? { reason: condition.reason } : {}),
      ...(typeof condition.message === 'string' ? { message: condition.message } : {}),
    }
  })
}

function isPodReady(item: unknown): boolean {
  const status = (item as { status?: Record<string, unknown> })?.status ?? {}
  return conditionsOf(status).some((c) => c.type === 'Ready' && c.status === 'True')
}

/** The pod's own `status.phase`, or a NAMED absence: a missing phase is not a `Running` one. */
function podPhase(item: unknown): string {
  const phase = (item as { status?: { phase?: unknown } })?.status?.phase
  return typeof phase === 'string' && phase ? phase : '(the pod reports no phase)'
}

/**
 * The first unsatisfied pod condition, as `Type=Status (Reason)`. The fallback for a pod with no
 * container statuses to walk, which is the shape of every pod that was never scheduled:
 * `PodScheduled=False (Unschedulable)` is the whole diagnosis there and lives nowhere else.
 */
function unreadyConditionOf(item: unknown): string {
  const status = (item as { status?: Record<string, unknown> })?.status ?? {}
  const failing = conditionsOf(status).find((c) => c.status !== 'True')
  if (!failing) return ''
  return `${failing.type}=${failing.status}${failing.reason ? ` (${failing.reason})` : ''}${
    failing.message ? `: ${failing.message}` : ''
  }`
}

/** The first container to read logs from: the one that is not ready, else the first declared. */
function firstContainerName(item: unknown): { container: string } | undefined {
  const statuses = (item as { status?: { containerStatuses?: unknown } })?.status?.containerStatuses
  const list = Array.isArray(statuses) ? statuses : []
  const broken = list.find((entry) => (entry as { ready?: unknown })?.ready === false)
  const pick = broken ?? list[0]
  const name = (pick as { name?: unknown })?.name
  return typeof name === 'string' ? { container: name } : undefined
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCli } from './exec.js'
import { cloneManifests } from './git.js'
import { writeKubeconfig } from './kubeconfig.js'
import { resolveLiveUrl } from './url.js'
import {
  type DeployJob,
  type HelmReleaseSpec,
  type ImageOverrideSpec,
  jobSecrets,
  type SecretInjectionSpec,
} from './job.js'
import type { JobResultBase, RunOptions } from './runner.js'

// handleDeploy: the deploy harness's one unit of work. Render a service's Kubernetes
// manifests with REAL kubectl/kustomize/helm and apply them into a per-PR namespace —
// the thing the native in-Worker REST adapter cannot do (it only applies raw, already-
// rendered manifests). Every templated/secret value arrives ALREADY RESOLVED in the job
// body (the backend resolves them against the workspace secret bundle before dispatch),
// so this never touches the bundle. The flow:
//
//   clone → resolve target namespace → ensure namespace → write secrets →
//   kustomize edits (namespace/images) → shared helm → apply (kubectl apply -k|-f) →
//   per-env helm → rollout status → URL
//
// It reports its coarse phase for the polled job view and returns a structured outcome
// the backend maps into a ProvisionedEnvironment (slice 8's finalizeProvision).

const FIELD_MANAGER = 'cat-factory'
const DEFAULT_ROLLOUT_SECONDS = 180

/** The structured environment outcome, carried on the job result's `custom` channel. */
export interface DeployOutcome {
  /** The namespace the env was provisioned into (the env's externalId). */
  namespace: string
  /** The resolved environment URL, or null until an address/host is assigned. */
  url: string | null
  /** `ready` once every Deployment rolled out; `provisioning` while any is still coming up. */
  status: 'ready' | 'provisioning'
}

export interface DeployResult extends JobResultBase {
  custom?: DeployOutcome
}

/** Build a `kustomize edit set image` argument from a resolved override. */
export function imageEditArg(img: ImageOverrideSpec): string {
  const rightName = img.newName ?? img.name
  const tag = img.newTag ? `:${img.newTag}` : ''
  const digest = img.digest ? `@${img.digest}` : ''
  return `${img.name}=${rightName}${tag}${digest}`
}

/** Render entries as a `KEY=value` env file body. */
export function renderEnvFile(entries: { key: string; value: string }[]): string {
  return entries.map((e) => `${e.key}=${e.value}`).join('\n') + '\n'
}

/** Build a Kubernetes Secret manifest (stringData) for a `secret`-mode injection. */
function buildSecretManifest(
  inj: Extract<SecretInjectionSpec, { mode: 'secret' }>,
  namespace: string,
  labels: Record<string, string> | undefined,
): string {
  const stringData: Record<string, string> = {}
  for (const e of inj.entries) stringData[e.key] = e.value
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: inj.secretName, namespace, ...(labels ? { labels } : {}) },
    type: inj.secretType ?? 'Opaque',
    stringData,
  })
}

/** Escape commas so a single `--set-string path=value` isn't split into multiple assignments. */
function helmSetArg(path: string, value: string): string {
  return `${path}=${value.replace(/,/g, '\\,')}`
}

/** Workload kinds whose namespace is the most reliable signal of where the env lives. */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod'])

/** The `kind:` of a single rendered manifest doc, or null. */
function docKind(doc: string): string | null {
  const m = doc.match(/^kind:[ \t]*["']?([A-Za-z0-9.]+)["']?[ \t]*$/m)
  return m ? m[1]! : null
}

/**
 * The namespace declared directly under a doc's top-level `metadata:` block, or null. Only a
 * `namespace:` at the metadata indentation is read, so a `namespace:` key nested elsewhere (a
 * ConfigMap's `data:`, a deeper spec field) is never mistaken for the resource's namespace.
 */
function docNamespace(doc: string): string | null {
  let inMeta = false
  for (const line of doc.split('\n')) {
    if (/^metadata:[ \t]*$/.test(line)) {
      inMeta = true
      continue
    }
    if (!inMeta) continue
    if (/^\S/.test(line)) break // a new zero-indent key ends the metadata block
    const m = line.match(/^[ \t]{2}namespace:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/)
    if (m) return m[1]!
  }
  return null
}

/**
 * The namespace a rendered manifest stream targets. kustomize's namespace transformer stamps
 * `metadata.namespace` on every namespaced resource, so an overlay that pins a namespace
 * carries it on each doc. Prefer a workload's namespace (Deployment/StatefulSet/…), else the
 * first namespaced resource. Null when the stream declares no namespace (the caller then keeps
 * the kubeconfig-context default).
 */
export function extractManifestNamespace(rendered: string): string | null {
  let fallback: string | null = null
  for (const doc of rendered.split(/^---[ \t]*$/m)) {
    const ns = docNamespace(doc)
    if (!ns) continue
    const kind = docKind(doc)
    if (kind && WORKLOAD_KINDS.has(kind)) return ns
    fallback ??= ns
  }
  return fallback
}

export async function handleDeploy(job: DeployJob, opts: RunOptions): Promise<DeployResult> {
  const secrets = jobSecrets(job)
  const log = opts.log
  const kube = await writeKubeconfig(job.cluster)
  const workDir = await mkdtemp(join(tmpdir(), 'deploy-'))

  // Every CLI call shares the kubeconfig env + the job's redaction set, and resets the
  // inactivity watchdog on completion so a multi-minute apply/helm/rollout isn't killed.
  const cli = (
    cmd: string,
    args: string[],
    extra: { cwd?: string; input?: string; timeoutMs?: number } = {},
  ) =>
    runCli(cmd, args, {
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
      ...(extra.input !== undefined ? { input: extra.input } : {}),
      ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      env: kube.env,
      redactSecrets: secrets,
      ...(log ? { log } : {}),
    }).then((r) => {
      opts.onActivity?.()
      return r
    })

  try {
    // --- clone ------------------------------------------------------------
    opts.onPhase?.('clone')
    await cloneManifests({
      cloneUrl: job.source.cloneUrl,
      ref: job.source.ref,
      dir: workDir,
      ...(job.ghToken ? { ghToken: job.ghToken } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      redactSecrets: secrets,
      ...(log ? { log } : {}),
    })
    opts.onActivity?.()
    const sourcePath = join(workDir, job.source.path)

    // Resolve the namespace the manifests actually target BEFORE we create/monitor it. With
    // per-PR isolation (`setNamespace`) the backend's namespace is pinned and authoritative;
    // without it, a kustomize overlay may declare its OWN namespace, so we read it back from
    // the built manifests — every later step (ensure / secrets / helm / rollout / URL /
    // outcome / teardown) must operate on the namespace the resources land in, not a stray
    // per-PR default that would be created empty, never torn down, and break URL/rollout.
    const namespace = await resolveTargetNamespace(cli, job, sourcePath)

    // --- ensure namespace -------------------------------------------------
    opts.onPhase?.('namespace')
    await ensureNamespace(cli, namespace, job.labels)

    // --- write resolved secrets ------------------------------------------
    opts.onPhase?.('secrets')
    for (const inj of job.secretInjections ?? []) {
      if (inj.mode === 'generatorEnvFile') {
        // The path is repo-relative; the overlay's own secretGenerator reads it at build.
        const target = join(workDir, inj.envFilePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, renderEnvFile(inj.entries), 'utf8')
      } else {
        // Materialize the Secret directly in the namespace (no overlay generator).
        await cli('kubectl', ['apply', '-f', '-', '-n', namespace], {
          input: buildSecretManifest(inj, namespace, job.labels),
        })
      }
    }

    // --- kustomize edits (namespace override + image overrides) ----------
    if (job.source.renderer === 'kustomize') {
      opts.onPhase?.('render')
      if (job.setNamespace) {
        await cli('kustomize', ['edit', 'set', 'namespace', namespace], { cwd: sourcePath })
      }
      const imageArgs = (job.images ?? []).map(imageEditArg)
      if (imageArgs.length > 0) {
        await cli('kustomize', ['edit', 'set', 'image', ...imageArgs], { cwd: sourcePath })
      }
    }

    // --- shared helm releases (cluster singletons, before the manifests) --
    const helm = job.helmReleases ?? []
    const shared = helm.filter((r) => r.scope === 'shared')
    const perEnv = helm.filter((r) => r.scope !== 'shared')
    if (shared.length > 0) opts.onPhase?.('helm')
    for (const rel of shared) await installHelmRelease(cli, rel, namespace, workDir)

    // --- apply ------------------------------------------------------------
    opts.onPhase?.('apply')
    const applyFlag = job.source.renderer === 'kustomize' ? '-k' : '-f'
    await cli('kubectl', ['apply', applyFlag, sourcePath, `--field-manager=${FIELD_MANAGER}`])

    // --- per-environment helm releases ------------------------------------
    if (perEnv.length > 0) opts.onPhase?.('helm')
    for (const rel of perEnv) await installHelmRelease(cli, rel, namespace, workDir)

    // --- rollout status ---------------------------------------------------
    opts.onPhase?.('rollout')
    const ready = await waitForRollouts(cli, namespace, job.rolloutTimeoutSeconds, log)

    // --- URL discovery ----------------------------------------------------
    opts.onPhase?.('url')
    const url = await discoverUrl(cli, job, namespace, log)

    return { custom: { namespace, url, status: ready ? 'ready' : 'provisioning' } }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    await rm(dirname(kube.path), { recursive: true, force: true }).catch(() => {})
  }
}

type Cli = (
  cmd: string,
  args: string[],
  extra?: { cwd?: string; input?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>

/**
 * The namespace the deploy targets. With `setNamespace` (per-PR isolation) the backend's
 * `cluster.namespace` is pinned via `kustomize edit set namespace`, so it is authoritative.
 * Without it, a kustomize overlay may declare its OWN namespace; build the overlay and read it
 * back so every later step operates on the namespace the resources actually land in. Falls back
 * to `cluster.namespace` for a raw source, an overlay that pins no namespace (its resources then
 * inherit the kubeconfig-context default), or a build that can't be read.
 */
async function resolveTargetNamespace(
  cli: Cli,
  job: DeployJob,
  sourcePath: string,
): Promise<string> {
  if (job.source.renderer !== 'kustomize' || job.setNamespace) return job.cluster.namespace
  try {
    const { stdout } = await cli('kustomize', ['build', sourcePath])
    return extractManifestNamespace(stdout) ?? job.cluster.namespace
  } catch {
    return job.cluster.namespace
  }
}

/** Create the namespace if absent (idempotent), stamping any extra labels. */
async function ensureNamespace(
  cli: Cli,
  namespace: string,
  labels: Record<string, string> | undefined,
): Promise<void> {
  const body = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: namespace, ...(labels ? { labels } : {}) },
  })
  // `apply` is idempotent (create-or-update), so a re-dispatch never 409s on the namespace.
  await cli('kubectl', ['apply', '-f', '-'], { input: body })
}

/** `helm upgrade --install` a resolved release. */
async function installHelmRelease(
  cli: Cli,
  rel: HelmReleaseSpec,
  envNamespace: string,
  workDir: string,
): Promise<void> {
  const ns = rel.namespace ?? envNamespace
  const args = [
    'upgrade',
    '--install',
    rel.name,
    rel.chart,
    '--version',
    rel.version,
    '-n',
    ns,
    '--create-namespace',
  ]
  if (rel.repo) args.push('--repo', rel.repo)
  for (const s of rel.set ?? []) args.push('--set-string', helmSetArg(s.path, s.value))
  if (rel.values && Object.keys(rel.values).length > 0) {
    // JSON is valid YAML, so helm reads the values file fine.
    const valuesPath = join(workDir, `helm-values-${rel.name}.json`)
    await writeFile(valuesPath, JSON.stringify(rel.values), 'utf8')
    args.push('-f', valuesPath)
  }
  await cli('helm', args)
}

/**
 * `kubectl rollout status` every Deployment in the namespace, bounded by the timeout.
 * A timeout/failure for one Deployment is NOT fatal — the env is simply reported
 * `provisioning` (the backend keeps polling), so a slow image pull doesn't fail the run.
 */
async function waitForRollouts(
  cli: Cli,
  namespace: string,
  timeoutSeconds: number | undefined,
  log: RunOptions['log'],
): Promise<boolean> {
  const seconds = timeoutSeconds ?? DEFAULT_ROLLOUT_SECONDS
  const timeout = `${seconds}s`
  // Give the per-command wall-clock (exec.ts COMMAND_TIMEOUT_MS) headroom over kubectl's
  // own `--timeout`, so a rollout window larger than that default isn't silently truncated
  // (kubectl returns its own timeout first; the outer cap is only a backstop).
  const timeoutMs = seconds * 1000 + 30_000
  let listFailed = false
  const list = await cli('kubectl', ['get', 'deploy', '-n', namespace, '-o', 'name']).catch(
    (err) => {
      listFailed = true
      log?.info('could not list deployments for rollout check', {
        reason: err instanceof Error ? err.message : String(err),
      })
      return { stdout: '', stderr: '' }
    },
  )
  const names = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // An empty list means "nothing to roll out" ONLY when the read actually succeeded (e.g.
  // a service with no Deployments). If the list call itself failed (RBAC, expired token, a
  // transient apiserver error), report not-ready so the env stays `provisioning` and the
  // backend keeps polling — never falsely `ready` on an unverified namespace.
  if (names.length === 0) return !listFailed
  let allReady = true
  for (const name of names) {
    try {
      await cli('kubectl', ['rollout', 'status', name, '-n', namespace, `--timeout=${timeout}`], {
        timeoutMs,
      })
    } catch (err) {
      allReady = false
      log?.info('rollout not complete yet', {
        resource: name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return allReady
}

/** Resolve the env URL via a kubectl-backed JSON reader; best-effort (null on any read error). */
async function discoverUrl(
  cli: Cli,
  job: DeployJob,
  namespace: string,
  log: RunOptions['log'],
): Promise<string | null> {
  try {
    return await resolveLiveUrl(job.url, namespace, async (args) => {
      const { stdout } = await cli('kubectl', args)
      return JSON.parse(stdout) as unknown
    })
  } catch (err) {
    log?.info('URL not resolvable yet', {
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

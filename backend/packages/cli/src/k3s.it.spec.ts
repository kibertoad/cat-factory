import { registerEnvironmentHandlerSchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { afterAll, describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { createNodeShell } from './host-shell.js'
import {
  buildK3sHandler,
  buildK3sSetupUrl,
  KUBERNETES_ENV_TOKEN_SECRET_KEY,
} from './k3s-handler.js'
import { probeHost } from './k3s-probe.js'
import {
  CAT_FACTORY_NAMESPACE,
  looksLocalCluster,
  normalizeApiServerUrl,
  provisionCluster,
  readApiServerCommand,
  SERVICE_ACCOUNT_NAME,
} from './k3s-provision.js'
import { type Io } from './io.js'

// INTEGRATION: drives the CLI's REAL k3s guided-setup logic (`probeHost` + `provisionCluster`
// over the process-backed `createNodeShell()`) against a REAL k3d cluster — the same cf-it
// cluster the `test-k8s` CI job stands up — so the "already set up before" re-run behaviour the
// unit tests only mock is validated for real: the recommendation flips to reuse, `kubectl apply`
// reconciles the namespace/SA/RBAC, the long-lived token is byte-identical across re-provisions
// (no rotation — so a token already saved in the UI keeps working), and nothing is duplicated.
//
// Self-skips (with a reason) when the current kubeconfig context is not a reachable LOCAL
// cluster, so a developer with no cluster — and any non-Kubernetes PR — runs zero infra, and we
// never mutate a remote/production cluster. The `looksLocalCluster` gate mirrors the safety
// invariant `provisionCluster` itself enforces in `--yes` mode.

const shell = createNodeShell()
const state = await probeHost(shell)
const context = state.detections.clusterContext
const readApiServer = readApiServerCommand()
const apiServerUrl = state.detections.reachableCluster
  ? normalizeApiServerUrl((await shell.run(readApiServer.cmd, readApiServer.args)).stdout.trim())
  : ''
const skip = !state.detections.reachableCluster
  ? 'no reachable cluster on the current kubeconfig context'
  : !looksLocalCluster(context, apiServerUrl)
    ? `current context "${context ?? '?'}" (${apiServerUrl}) does not look local — refusing to mutate it`
    : null

/** k3s CLI options for a non-interactive integration run (never prompts; skips the browser). */
function opts(extra: Partial<CliOptions> = {}): CliOptions {
  return { command: 'k3s', noOpen: true, yes: true, force: false, ...extra }
}

/** A silent Io — provisioning drives its confirms via `--yes`, so nothing here is interactive. */
function silentIo(): Io {
  return {
    info: () => {},
    warn: () => {},
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) => Promise.resolve(d),
    secret: () => Promise.resolve(''),
    confirm: () => Promise.resolve(true),
    openBrowser: () => Promise.resolve(),
  }
}

describe.skipIf(skip !== null)(
  `k3s guided setup (k3d integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    // A k3d context is `k3d-<name>`; the create-k3d reuse branch keys off the cluster name, so
    // only exercise it when the live cluster is a k3d one whose name the probe also listed.
    const k3dName = context?.startsWith('k3d-') ? context.slice('k3d-'.length) : undefined
    const canReuseCreatePath = !!k3dName && state.detections.k3dClusters.includes(k3dName)

    afterAll(async () => {
      // Best-effort teardown of everything the guided setup provisions, so the suite leaves the
      // shared cluster as it found it and a re-run starts clean.
      await shell.run('kubectl', [
        'delete',
        'namespace',
        CAT_FACTORY_NAMESPACE,
        '--ignore-not-found',
      ])
      await shell.run('kubectl', ['delete', 'clusterrole', 'cat-factory-env', '--ignore-not-found'])
      await shell.run('kubectl', [
        'delete',
        'clusterrolebinding',
        'cat-factory-env',
        '--ignore-not-found',
      ])
    })

    it('probe reports the reachable local cluster and recommends reusing it', () => {
      expect(state.detections.reachableCluster).toBe(true)
      expect(state.detections.kubectl.installed).toBe(true)
      const useExisting = state.offers.find((o) => o.id === 'use-existing')
      expect(useExisting?.available).toBe(true)
      // Once a cluster is reachable, reuse always wins the recommendation — a second run of the
      // guided setup never tries to create a duplicate cluster.
      expect(state.recommended).toBe('use-existing')
    })

    it('use-existing provisions idempotently: same token across re-runs, no duplicate resources', async () => {
      const first = await provisionCluster('use-existing', state, opts(), { io: silentIo(), shell })
      expect(first.engine).toBe('local-k3s')
      expect(first.apiServerUrl).toMatch(/^https:\/\//)
      expect(first.apiToken.length).toBeGreaterThan(0)
      // The reuse path never names a created cluster.
      expect(first.clusterName).toBeUndefined()

      // The namespace + ServiceAccount + long-lived token Secret really landed in the cluster.
      const saGet = await shell.run('kubectl', [
        '-n',
        CAT_FACTORY_NAMESPACE,
        'get',
        'serviceaccount',
        SERVICE_ACCOUNT_NAME,
      ])
      expect(saGet.code).toBe(0)

      // Re-run the WHOLE provisioning against the same cluster: `kubectl apply` reconciles the
      // SA/RBAC, and the long-lived token Secret is preserved — so the token is byte-identical.
      // This is the core "already completed before" guarantee: a re-run does not rotate a token
      // the user may already have pasted into the UI.
      const second = await provisionCluster('use-existing', state, opts(), {
        io: silentIo(),
        shell,
      })
      expect(second.apiToken).toBe(first.apiToken)
      expect(second.apiServerUrl).toBe(first.apiServerUrl)

      // Exactly one ServiceAccount named `cat-factory` exists — nothing was duplicated.
      const saCount = await shell.run('kubectl', [
        '-n',
        CAT_FACTORY_NAMESPACE,
        'get',
        'serviceaccount',
        SERVICE_ACCOUNT_NAME,
        '-o',
        'jsonpath={.metadata.name}',
      ])
      expect(saCount.stdout.trim()).toBe(SERVICE_ACCOUNT_NAME)
    })

    it.skipIf(!canReuseCreatePath)(
      'create-k3d reuses the already-running named cluster (no create) and provisions via --context',
      async () => {
        const conn = await provisionCluster('create-k3d', state, opts({ clusterName: k3dName }), {
          io: silentIo(),
          shell,
        })
        // The create-k3d path names the (reused) cluster and still mints a working connection —
        // exercising its explicit `--context k3d-<name>` targeting against the real apiserver.
        expect(conn.clusterName).toBe(k3dName)
        expect(conn.apiToken.length).toBeGreaterThan(0)
        expect(conn.apiServerUrl).toMatch(/^https:\/\//)
      },
    )

    it('builds a schema-valid infra handler + deep-link from the REAL provisioned connection', async () => {
      const conn = await provisionCluster('use-existing', state, opts(), { io: silentIo(), shell })
      const handler = buildK3sHandler(conn)

      // Validate the built handler against the REAL contract schema (`@cat-factory/contracts` is a
      // devDependency) using the token/URL a real cluster just produced — the end-to-end shape the
      // Settings → Local k3s form's Test/Save would post.
      const parsed = v.parse(registerEnvironmentHandlerSchema, handler)
      expect(parsed.provisionType).toBe('kubernetes')
      expect(parsed.config.engine).toBe('local-k3s')
      expect(handler.secrets[KUBERNETES_ENV_TOKEN_SECRET_KEY]).toBe(conn.apiToken)

      const link = buildK3sSetupUrl('http://localhost:3000', handler)
      const url = new URL(link)
      expect(url.searchParams.get('infraSetup')).toBe('local-k3s')
      expect(url.searchParams.get('apiServerUrl')).toBe(conn.apiServerUrl)
      // The minted token must never ride in the deep-link (it would leak into browser history).
      expect(link).not.toContain(conn.apiToken)
    })
  },
)

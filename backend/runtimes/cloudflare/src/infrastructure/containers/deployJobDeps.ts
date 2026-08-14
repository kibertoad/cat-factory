import type { Clock } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { makeResolveDeployCloneTarget, RunnerJobClient } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import type { AppConfig } from '../config'
import type { Env } from '../env'
import { buildAppRegistry, buildResolveRepoTarget, workerDispatchTokenMint } from '../container'
import {
  CloudflareContainerTransport,
  fixedContainerNamespace,
} from './CloudflareContainerTransport'

/**
 * Wire the async, container-backed Kubernetes deploy lifecycle (slice 9's
 * `EnvironmentProvisioningService` seams) onto the Worker facade: a `deployJobClient` that
 * dispatches/polls/releases a `deploy`-kind job on the per-run `DeployContainer` (the separate
 * deploy-harness image — real `kubectl`/`kustomize`/`helm`), plus `resolveDeployCloneTarget` to
 * hand the container concrete manifests-repo clone coords + a short-lived install token.
 *
 * Gated on the environments module, the `DEPLOY_CONTAINER` binding AND the GitHub App
 * (the clone-target seam needs to mint install tokens + resolve a block's repo). Absent any
 * prerequisite ⇒ `{}` — a render-needing config then fails loudly (the synchronous raw-manifest
 * REST path is unaffected), exactly the unwired behaviour slice 9 shipped. Mirrors Node's pool
 * deploy wiring; the deploy container is the Worker's analogue of Node's self-hosted pool.
 */
export function selectDeployDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): Partial<CoreDependencies> {
  if (
    !config.environments.encryptionKey ||
    !env.DEPLOY_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY
  ) {
    return {}
  }
  // A deploy-DEDICATED transport: the deploy job's `ref.runId` addresses a `DeployContainer`
  // instance in its own DO namespace (no collision with the agent `EXEC_CONTAINER`), and the
  // harness keys the job by `ref.jobId`. No instance registry is wired (the `sleepAfter` idle
  // timer + explicit `release` reclaim it), so cross-namespace reaping stays the exec
  // container's concern. The client is deploy-only, so `poll`/`release` need no per-ref routing.
  const deployTransport = new CloudflareContainerTransport(
    fixedContainerNamespace(env.DEPLOY_CONTAINER),
    undefined,
    env.HARNESS_SHARED_SECRET?.trim() || undefined,
  )
  const registry = buildAppRegistry(env, config, db, clock)
  return {
    deployJobClient: new RunnerJobClient(async () => deployTransport),
    // Narrowed to the repo being rendered, like every other container dispatch.
    resolveDeployCloneTarget: makeResolveDeployCloneTarget(
      buildResolveRepoTarget(db),
      workerDispatchTokenMint(registry),
    ),
  }
}

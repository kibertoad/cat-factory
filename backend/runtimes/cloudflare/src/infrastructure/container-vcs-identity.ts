// The Worker's VCS IDENTITY + REPO-TARGETING building blocks: the multi-App GitHub registry
// (which App's key signs a given installation's token) and the two resolvers that map a running
// block to the repo(s) its work belongs in.
//
// These three are the composition root's most widely SHARED pieces — the GitHub module, the
// tracker wiring, the merge-lifecycle deps, the executor and the assembly step all need them —
// so they live beside it rather than in it: every consumer imports them from here, and none of
// them has to import the root (which imports several of those consumers back).

import { type Clock, createInitiatorPatGate } from '@cat-factory/kernel'
import {
  type ResolveRunInitiatorToken,
  buildResolveRepoTarget as buildSharedResolveRepoTarget,
  buildResolveRepoTargets as buildSharedResolveRepoTargets,
  createResolveRunInitiatorToken,
  logger,
} from '@cat-factory/server'
import { type AppConfig } from './config'
import type { Env } from './env'
import { type ResolveRepoTarget, type ResolveRepoTargets } from './ai/ContainerAgentExecutor'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ServiceRepository } from './repositories/D1ServiceRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { GitHubAppRegistry } from './github/GitHubAppRegistry'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { buildResolveUserGitHubToken } from './wireCredentialServices'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * Build the multi-App registry (ADR 0005): the default App always, plus the
 * privileged App when configured. It resolves which App's key to use per
 * installation (from the binding's recorded appId), so every token mint / app-JWT
 * call routes correctly. Callers guard on `config.github.enabled`, which requires
 * GITHUB_APP_PRIVATE_KEY, so the default key is present.
 */
export function buildAppRegistry(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): GitHubAppRegistry {
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const makeAuth = (appId: string, privateKeyPem: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  const privileged =
    config.github.privilegedApp && env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, env.GITHUB_APP_PRIVATE_KEY!),
    },
    privileged,
    installationRepository,
  })
}

/**
 * Resolve the repo linked to a running block's enclosing service, via the shared
 * runtime-neutral `buildResolveRepoTarget` (the ancestry walk + no-fallback policy
 * live in `@cat-factory/server` so the Worker and Node service can't drift). This
 * wrapper just binds the D1 repositories. Shared by the container executor, the CI
 * status provider and the PR merger.
 *
 * No `repoProjectionCache` is threaded here (unlike the Node facade, which caches the
 * whole-projection re-list per workspace — caching-layer slice 3): the repo projection
 * is our own mutable D1 state, and the Worker's isolate-safe profile makes that cache
 * pass-through (no cross-isolate invalidation bus), so an in-isolate TTL would serve
 * stale repos after a write on another isolate. Reading live IS the isolate-safe
 * behaviour. The shared GitHub sync/webhook services still receive the (pass-through)
 * handle via `createGitHubModule`, so their invalidation code path stays symmetric.
 */
export function buildResolveRepoTarget(db: D1Database): ResolveRepoTarget {
  return buildSharedResolveRepoTarget({
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
  })
}

/**
 * The MULTI-REPO resolver (service-connections phase 3): the task's own repo plus each
 * connected involved-service repo, deduped. Wired from the SAME D1 repos as the singular
 * resolver (the D1 service repo's batched `listByFrameBlocks` resolves the involved frames'
 * repos in one query). Fed to the container executor so the implementer can fan a
 * cross-service change out across sibling checkouts.
 */
export function buildResolveRepoTargets(db: D1Database): ResolveRepoTargets {
  return buildSharedResolveRepoTargets({
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
  })
}

/**
 * "Does THIS run act with its initiator's own GitHub token?" — built HERE, beside the App
 * registry, because the Worker asks it from two composition sites (the engine's GitHub client
 * in `container.ts`, the container push-token mint in `container-executor-deps.ts`) and a
 * per-site copy is a chance for the workspace's `allowInitiatorPat` switch to bind one and
 * miss the other. Undefined when no per-user secret store is wired (no `ENCRYPTION_KEY`),
 * which is the same condition that already made the preference inert.
 */
export function buildResolveRunInitiatorToken(
  env: Env,
  db: D1Database,
  clock: Clock,
): ResolveRunInitiatorToken | undefined {
  const resolveUserGitHubToken = buildResolveUserGitHubToken(env, db, clock)
  if (!resolveUserGitHubToken) return undefined
  return createResolveRunInitiatorToken({
    resolveUserGitHubToken,
    // No cache slice: `workspaceSettings` is `enabled: false` in the Worker's isolate-safe
    // profile (our own mutable state, with no cross-isolate invalidation bus), so passing it
    // would be a pass-through anyway.
    initiatorPatGate: createInitiatorPatGate({
      repository: new D1WorkspaceSettingsRepository({ db }),
    }),
    logger,
  })
}

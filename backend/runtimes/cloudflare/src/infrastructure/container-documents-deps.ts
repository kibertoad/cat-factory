import type { Clock, DocumentSourceProvider, IdGenerator } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  ConfluenceProvider,
  FigmaProvider,
  GitHubDocsProvider,
  LinearDocumentProvider,
  NotionProvider,
  ZeplinProvider,
  resolveDeploymentDocumentResolver,
} from '@cat-factory/integrations'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { WebCryptoSecretCipher } from '@cat-factory/server'
import type { AppConfig } from './config'
import type { Env } from './env'
import { D1DocumentConnectionRepository } from './repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { buildAppRegistry } from './container-vcs-identity'
import { buildModelProviderResolver } from './container-model-resolver'
import { logger } from './observability/logger'

// The DOCUMENT-SOURCE slice of the Worker composition root, extracted from `container.ts` when
// the deployment-scoped credential home pushed that file past its size budget. A cohesive seam
// rather than an arbitrary cut: everything here answers one question, which is how this runtime
// reaches an external document, and it is the only slice with TWO credential homes to keep
// straight (a tenant's stored connection, and the deployment's own environment).

/**
 * The DEPLOYMENT's own document resolver for this Worker's `env`, as a `CoreDependencies` slice.
 *
 * Exported because the Worker has TWO callers that must agree about it and only one of them builds
 * a container: `createWorker`'s first-request registration check reads it to decide whether a
 * code-registered `documentRef` is servable, and passing that check anything less than what the
 * engine will actually hold made every such fragment fail validation on a correctly configured
 * deployment.
 *
 * Deriving it from `env` alone (rather than sharing an instance) is what lets the two agree: the
 * resolver holds no mutable state, so the configuration IS the whole answer.
 */
export function deploymentDocumentDeps(env: Env): Partial<CoreDependencies> {
  const { resolver } = resolveDeploymentDocumentResolver(deploymentEnvRecord(env))
  return resolver ? { deploymentDocumentResolver: resolver } : {}
}

/**
 * Every source whose deployment credentials are set but UNUSABLE, for the caller that reports once.
 *
 * Split from {@link deploymentDocumentDeps} because the two have different audiences and different
 * cardinalities: the container build wants the resolver on every build and must stay silent, while
 * the report is a boot-shaped event this runtime has to stage for itself.
 */
export function deploymentDocumentProblems(
  env: Env,
): { source: string; problem: string }[] {
  return resolveDeploymentDocumentResolver(deploymentEnvRecord(env)).problems
}

/** The Worker's bindings read as a plain variable bag, which is all the resolver wants. */
function deploymentEnvRecord(env: Env): Record<string, string | undefined> {
  return env as unknown as Record<string, string | undefined>
}

/**
 * Build the document-source integration's concrete ports: the configured source
 * providers (Confluence, Notion, …) plus the two D1 repositories. The integration is
 * always on (config load fails loudly without the encryption key), so this is wired
 * on every deployment. The model provider is wired only in 'llm' planner mode (it
 * just needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable.
 */
export function selectDocumentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
  // GitHub repo docs reuse the workspace's installed GitHub App, so this provider
  // is wired only when the GitHub integration is also configured: it has no
  // credentials of its own and resolves the installation per file (mirrors the
  // GitHub-issues task source).
  if (config.documents.sources.includes('github') && config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubDocsProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
        logger,
      }),
    )
  }
  // The DEPLOYMENT's own document credentials, read from the Worker's `env` bindings (never from a
  // tenant's stored connection) so a code-registered prompt fragment may name a living standard.
  // Resolved BEFORE, and independently of, the `DOCUMENT_SOURCES` gate above: that governs what a
  // TENANT may connect, and answering both questions from one switch made a deployment that had set
  // its `DOC_SOURCE_*` variables correctly meet a refusal naming variables it had already set.
  //
  // SILENT here, unlike the Node facades: this runs on every container build (per request, and
  // again for every cron tick and queue message), so an unusable-credentials warning belongs at the
  // once-guarded first-request validation in `index.ts`, which reports it exactly once per isolate.
  const deploymentDocuments = deploymentDocumentDeps(env)
  if (providers.length === 0) return deploymentDocuments
  return {
    ...deploymentDocuments,
    documentSourceProviders: providers,
    documentConnectionRepository: new D1DocumentConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a documents-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey!,
        info: 'cat-factory:documents',
      }),
    }),
    documentRepository: new D1DocumentRepository({ db }),
    ...(config.documents.planner === 'llm'
      ? {
          modelProviderResolver: buildModelProviderResolver(env, db),
          documentPlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

import type { Clock, DocumentSourceProvider, IdGenerator } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  ConfluenceProvider,
  FigmaProvider,
  GitHubDocsProvider,
  LinearDocumentProvider,
  NotionProvider,
  ZeplinProvider,
  buildDeploymentDocumentResolver,
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
  if (providers.length === 0) return {}
  // The DEPLOYMENT's own document credentials, read from the Worker's `env` bindings (never from a
  // tenant's stored connection) so a code-registered prompt fragment may name a living standard.
  // A source whose variables are present but unusable is REPORTED and left unconfigured, which
  // makes boot validation refuse any fragment naming it rather than let it fold a stale body.
  const deployment = buildDeploymentDocumentResolver(
    providers,
    env as unknown as Record<string, string | undefined>,
  )
  for (const { source, problem } of deployment.problems) {
    logger.warn(
      'Deployment-wide document-source credentials are set but unusable, so this source cannot ' +
        'back a code-registered prompt fragment',
      { source, problem },
    )
  }
  return {
    documentSourceProviders: providers,
    ...(deployment.resolver ? { deploymentDocumentResolver: deployment.resolver } : {}),
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

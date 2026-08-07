import type {
  DeploymentDocumentResolver,
  DocumentContent,
  DocumentCredentials,
  DocumentSourceKind,
  DocumentSourceProvider,
  DocumentSourceRegistry,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { isDeploymentScopedSource } from '@cat-factory/contracts'
import { MapDocumentSourceRegistry } from './documents.logic.js'
import { ConfluenceProvider } from './ConfluenceProvider.js'
import { FigmaProvider } from './FigmaProvider.js'
import { LinearDocumentProvider } from './LinearDocumentProvider.js'
import { NotionProvider } from './NotionProvider.js'
import { ZeplinProvider } from './ZeplinProvider.js'

// DeploymentDocumentResolverService: the runtime read seam for a document the DEPLOYMENT owns,
// the living standard a code-registered (`builtin`-tier) prompt fragment names.
//
// The sibling of `DocumentContentResolverService`, and separate from it for one reason: the
// CREDENTIAL HOME. That one resolves a workspace's stored connection; this one holds credentials
// the deployment configured centrally and passes the DEPLOYMENT scope (`null`) to the provider, so
// no tenant's credential is ever spent on a read every tenant benefits from.
//
// Everything else is identical, deliberately: the same providers, the same `fetchDocument` /
// `probeVersion`, the same throw-on-unreachable contract that lets the caller decide whether to
// degrade to a persisted body.

export interface DeploymentDocumentResolverServiceDependencies {
  registry: DocumentSourceRegistry
  /**
   * The deployment's configured credentials per source, already validated (see
   * {@link deploymentDocumentCredentialsFromEnv}). A source absent from the map is one the
   * deployment did not configure, which {@link DeploymentDocumentResolverService.configured}
   * reports and every read refuses.
   */
  credentials: ReadonlyMap<DocumentSourceKind, DocumentCredentials>
}

export class DeploymentDocumentResolverService implements DeploymentDocumentResolver {
  constructor(private readonly deps: DeploymentDocumentResolverServiceDependencies) {}

  configured(source: DocumentSourceKind): boolean {
    return this.deps.credentials.has(source) && this.deps.registry.get(source) !== undefined
  }

  async fetch(source: DocumentSourceKind, externalId: string): Promise<DocumentContent> {
    const { provider, credentials } = this.resolve(source)
    return provider.fetchDocument(credentials, externalId, null)
  }

  async probeVersion(source: DocumentSourceKind, externalId: string): Promise<string> {
    const { provider, credentials } = this.resolve(source)
    return provider.probeVersion(credentials, externalId, null)
  }

  /**
   * The provider plus the deployment's credentials for a source.
   *
   * Three distinct refusals rather than one, because they need three different fixes: the source
   * cannot be deployment-scoped AT ALL (a trait, so no configuration helps), the deployment did not
   * configure it (add the variables), or the provider is not wired in this build. Collapsing them
   * would put an operator who set the wrong variable and one who chose an impossible source on the
   * same dead end.
   */
  private resolve(source: DocumentSourceKind): {
    provider: DocumentSourceProvider
    credentials: DocumentCredentials
  } {
    if (!isDeploymentScopedSource(source)) {
      throw new ValidationError(
        `Document source '${source}' cannot be configured deployment-wide: its credential belongs ` +
          `to a workspace rather than to the deployment. Use a source whose credentials are ` +
          `self-contained, or create the fragment at the account tier with a fetch-via workspace.`,
      )
    }
    const provider = this.deps.registry.get(source)
    if (!provider) {
      throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    }
    const credentials = this.deps.credentials.get(source)
    if (!credentials) {
      throw new ValidationError(
        `This deployment has no credentials configured for document source '${source}'. Set the ` +
          `${envPrefixFor(source)}_* variables (see docs/environment-variables.md).`,
      )
    }
    return { provider, credentials }
  }
}

/**
 * The environment-variable prefix a source's deployment credentials are read from.
 *
 * DERIVED from the source id rather than a per-source constant, so a new source needs no entry
 * here and cannot ship with a name only half the code agrees on.
 */
export function envPrefixFor(source: DocumentSourceKind): string {
  return `DOC_SOURCE_${source.toUpperCase()}`
}

/** The variable one credential field is read from, e.g. `DOC_SOURCE_CONFLUENCE_API_TOKEN`. */
export function envKeyFor(source: DocumentSourceKind, fieldKey: string): string {
  // A field key is camelCase (`apiToken`, `baseUrl`); the variable is SCREAMING_SNAKE, which is
  // what every other variable in this deployment looks like.
  const screaming = fieldKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
  return `${envPrefixFor(source)}_${screaming}`
}

/**
 * Assemble the deployment's document resolver from its environment, or `undefined` when it
 * configured no source at all.
 *
 * One helper both Node-hosted facades and the Worker call, so the variables a deployment sets mean
 * the same thing on every runtime. `problems` names each source whose variables are present but
 * unusable: the caller LOGS them and the source stays unconfigured, which then makes boot
 * validation refuse any code-registered fragment naming it. A half-typed variable therefore ends at
 * a refusal that names the source, never at a fragment silently folding its registered body.
 */
export function buildDeploymentDocumentResolver(
  providers: readonly DocumentSourceProvider[],
  env: Record<string, string | undefined>,
  /** Defaults to a registry over `providers`, which is what every facade wants. */
  registry: DocumentSourceRegistry = new MapDocumentSourceRegistry([...providers]),
): {
  resolver?: DeploymentDocumentResolverService
  configured: DocumentSourceKind[]
  problems: { source: DocumentSourceKind; problem: string }[]
} {
  const results = deploymentDocumentCredentialsFromEnv(providers, env)
  const credentials = new Map<DocumentSourceKind, DocumentCredentials>()
  const problems: { source: DocumentSourceKind; problem: string }[] = []
  for (const result of results) {
    if ('problem' in result) problems.push({ source: result.source, problem: result.problem })
    else credentials.set(result.source, result.credentials)
  }
  if (credentials.size === 0) return { configured: [], problems }
  return {
    resolver: new DeploymentDocumentResolverService({ registry, credentials }),
    configured: [...credentials.keys()],
    problems,
  }
}

/**
 * How to construct each document source's provider from NOTHING but this build, or `null` when it
 * cannot be built that way.
 *
 * Exhaustive over the closed vocabulary, so a new source fails to compile until it answers the
 * question. A `null` says the provider needs a per-workspace collaborator (`github` reaches a
 * document through the WORKSPACE's App installation), which is the same fact
 * `DOCUMENT_SOURCE_TRAITS.deploymentScoped` states from the contracts side; `deployment-scoped-providers`
 * in the test file beside this one pins the two against each other, so they cannot drift into a
 * source that is declared deployment-scopable and has no way to be built.
 */
const DEPLOYMENT_SCOPED_PROVIDER_FACTORIES: Record<
  DocumentSourceKind,
  (() => DocumentSourceProvider) | null
> = {
  confluence: () => new ConfluenceProvider(),
  notion: () => new NotionProvider(),
  figma: () => new FigmaProvider(),
  zeplin: () => new ZeplinProvider(),
  linear: () => new LinearDocumentProvider(),
  github: null,
}

/** Every document source this BUILD can serve deployment-wide, one fresh provider each. */
export function deploymentScopedDocumentProviders(): DocumentSourceProvider[] {
  return Object.values(DEPLOYMENT_SCOPED_PROVIDER_FACTORIES)
    .filter((factory) => factory !== null)
    .map((factory) => factory())
}

/**
 * The deployment's own document resolver, read from an environment and NOTHING else.
 *
 * The entry point all three facades call, and the reason it takes no config: what a TENANT may
 * connect (`DOCUMENT_SOURCES`, the documents integration being enabled at all, the connection
 * encryption key) and what the DEPLOYMENT configured for itself are different questions with
 * different credential homes. Deriving the second from the first made a deployment that had set its
 * `DOC_SOURCE_*` variables correctly get a refusal naming variables it had already set, because it
 * had not ALSO opened that source to its tenants: an unrelated, undiscoverable prerequisite.
 *
 * PURE, so the boot-time registration check and the per-request container build can each call it
 * and agree. The resolver holds no mutable state, so agreeing on the CONFIGURATION is the whole
 * requirement; there is no instance to share. `problems` is reported by the caller that boots (see
 * each facade), never per container build.
 */
export function resolveDeploymentDocumentResolver(env: Record<string, string | undefined>): {
  resolver?: DeploymentDocumentResolverService
  configured: DocumentSourceKind[]
  problems: { source: DocumentSourceKind; problem: string }[]
} {
  return buildDeploymentDocumentResolver(deploymentScopedDocumentProviders(), env)
}

/** One source the deployment configured, or the reason it could not be read. */
export type DeploymentDocumentCredentialResult =
  | { source: DocumentSourceKind; credentials: DocumentCredentials; label: string }
  | { source: DocumentSourceKind; problem: string }

/**
 * Read every deployment-scoped document source this environment configures, VALIDATING each
 * through its own provider's `normalizeConnection`.
 *
 * Generic over the descriptor rather than per-source, which is what keeps this from being six
 * bespoke config readers: a provider already self-describes the credentials it needs
 * (`descriptor.credentialFields`, the same list that renders the connect form), so the variables a
 * source reads are a function of that list and adding a source adds nothing here.
 *
 * A source is CONFIGURED when at least one of its variables is set. That is deliberate: reading
 * "none set" as "not configured" is right, but reading "some set" as "not configured" would let an
 * operator who typed one variable name wrong get silence where they expected a document, so a
 * partial configuration is reported as a PROBLEM and never quietly skipped. `normalizeConnection`
 * decides what "complete" means, since only the provider knows which of its fields are optional.
 */
export function deploymentDocumentCredentialsFromEnv(
  providers: readonly DocumentSourceProvider[],
  env: Record<string, string | undefined>,
): DeploymentDocumentCredentialResult[] {
  const results: DeploymentDocumentCredentialResult[] = []
  for (const provider of providers) {
    if (!isDeploymentScopedSource(provider.kind)) continue
    const bag: DocumentCredentials = {}
    let anySet = false
    for (const field of provider.descriptor.credentialFields) {
      const value = env[envKeyFor(provider.kind, field.key)]
      if (value === undefined || value.trim() === '') continue
      bag[field.key] = value
      anySet = true
    }
    if (!anySet) continue
    try {
      const normalized = provider.normalizeConnection(bag)
      results.push({
        source: provider.kind,
        credentials: normalized.credentials,
        label: normalized.label,
      })
    } catch (error) {
      // The provider's own validation is the authority on completeness, so its message is the one
      // an operator can act on. Naming the variables too, because the provider speaks in FIELD keys
      // and the operator set environment variables.
      results.push({
        source: provider.kind,
        problem:
          `${error instanceof Error ? error.message : String(error)} ` +
          `(configured via ${provider.descriptor.credentialFields
            .map((f) => envKeyFor(provider.kind, f.key))
            .join(', ')})`,
      })
    }
  }
  return results
}

import { describe, expect, it } from 'vitest'
import { deploymentScopedSources, isDeploymentScopedSource } from '@cat-factory/contracts'
import type { DocumentSourceKind, DocumentSourceProvider } from '@cat-factory/kernel'
import { ConfluenceProvider } from './ConfluenceProvider.js'
import { NotionProvider } from './NotionProvider.js'
import { GitHubDocsProvider } from './GitHubDocsProvider.js'
import {
  buildDeploymentDocumentResolver,
  deploymentScopedDocumentProviders,
  envKeyFor,
  deploymentDocumentCredentialsFromEnv,
  resolveDeploymentDocumentResolver,
} from './DeploymentDocumentResolverService.js'

// The DEPLOYMENT's credential home for document sources: `DOC_SOURCE_<SOURCE>_<FIELD>`, read
// through each provider's OWN self-description so adding a source adds no config code.

/** The GitHub docs provider needs collaborators it never reaches in these cases. */
const githubDocs = new GitHubDocsProvider({
  githubClient: {} as never,
  installations: {} as never,
  logger: undefined as never,
})

const providers: DocumentSourceProvider[] = [
  new ConfluenceProvider(),
  new NotionProvider(),
  githubDocs,
]

describe('deployment document credentials from the environment', () => {
  it('derives each variable from the provider’s OWN declared credential fields', () => {
    // The variables a source reads are a FUNCTION of the connect form it already declares, which is
    // what keeps this from being one bespoke config reader per source. Asserted against the
    // provider's own descriptor rather than a hard-coded list, so a renamed field moves both halves
    // together or fails here.
    const notion = new NotionProvider()
    for (const field of notion.descriptor.credentialFields) {
      expect(envKeyFor('notion', field.key)).toMatch(/^DOC_SOURCE_NOTION_[A-Z0-9_]+$/)
    }
    expect(envKeyFor('confluence', 'apiToken')).toBe('DOC_SOURCE_CONFLUENCE_API_TOKEN')
  })

  it('configures a source whose variables are set, and leaves the rest alone', () => {
    const notion = new NotionProvider()
    const env: Record<string, string> = {}
    for (const field of notion.descriptor.credentialFields) {
      env[envKeyFor('notion', field.key)] = 'secret-value'
    }

    const { resolver, configured, problems } = buildDeploymentDocumentResolver(providers, env)

    expect(problems).toEqual([])
    expect(configured).toEqual(['notion'])
    expect(resolver?.configured('notion')).toBe(true)
    expect(resolver?.configured('confluence')).toBe(false)
  })

  it('is undefined when the deployment set nothing, which is the ordinary deployment', () => {
    const built = buildDeploymentDocumentResolver(providers, {})
    expect(built.resolver).toBeUndefined()
    expect(built.configured).toEqual([])
    expect(built.problems).toEqual([])
  })

  it('REPORTS a partially-configured source rather than silently skipping it', () => {
    // The failure this exists for: an operator who typed one variable name wrong would otherwise
    // get a deployment that boots clean and folds a stale body forever. Reported here, the source
    // stays unconfigured and boot validation then refuses any fragment naming it.
    const confluence = new ConfluenceProvider()
    const fields = confluence.descriptor.credentialFields
    expect(fields.length).toBeGreaterThan(1) // else this case cannot exist for this provider
    const env = { [envKeyFor('confluence', fields[0]!.key)]: 'only-one-of-them' }

    const { resolver, problems } = buildDeploymentDocumentResolver(providers, env)

    expect(problems.map((p) => p.source)).toEqual(['confluence'])
    // The variables, not just the provider's field names: the operator set variables.
    expect(problems[0]?.problem).toContain('DOC_SOURCE_CONFLUENCE_')
    expect(resolver?.configured('confluence') ?? false).toBe(false)
  })

  it('never reads variables for a source that cannot be deployment-scoped', () => {
    // `github` docs authenticate with a WORKSPACE's App installation. Reading a `DOC_SOURCE_GITHUB_*`
    // variable would advertise a configuration that cannot work, so the trait is applied BEFORE the
    // environment is consulted rather than after.
    const env = { DOC_SOURCE_GITHUB_TOKEN: 'ghp_x' }
    expect(deploymentDocumentCredentialsFromEnv(providers, env)).toEqual([])
    expect(buildDeploymentDocumentResolver(providers, env).resolver).toBeUndefined()
  })

  it('classifies every source, so a new one cannot ship without deciding', () => {
    // A relation over the picklist rather than a pinned count: this asserts the classification is
    // TOTAL and that at least one source is on each side, which is what makes the trait meaningful.
    // A `toBe(5)` here would fail on every ordinary addition and name nothing about what broke.
    const all = (['confluence', 'notion', 'github', 'figma', 'zeplin', 'linear'] as const).map(
      (source) => source as DocumentSourceKind,
    )
    for (const source of all) expect(typeof isDeploymentScopedSource(source)).toBe('boolean')
    const scopable = deploymentScopedSources()
    expect(scopable.length).toBeGreaterThan(0)
    expect(scopable.length).toBeLessThan(all.length)
    expect(scopable).not.toContain('github')
  })
})

describe('the resolver itself', () => {
  it('refuses a source the deployment did not configure, naming the variables to set', async () => {
    const { resolver } = buildDeploymentDocumentResolver(providers, {
      [envKeyFor('notion', new NotionProvider().descriptor.credentialFields[0]!.key)]: 'x',
    })
    await expect(resolver!.fetch('confluence', 'page-1')).rejects.toThrow(/DOC_SOURCE_CONFLUENCE/)
  })

  it('refuses a source that can never be deployment-scoped with a DIFFERENT reason', async () => {
    // Two remedies, two messages: pointing an operator who chose an impossible source at a variable
    // sends them hunting for one that cannot exist.
    const { resolver } = buildDeploymentDocumentResolver(providers, {
      [envKeyFor('notion', new NotionProvider().descriptor.credentialFields[0]!.key)]: 'x',
    })
    await expect(resolver!.fetch('github', 'org/repo:g.md')).rejects.toThrow(
      /belongs\s+to a workspace/,
    )
  })
})

describe('the deployment provider set', () => {
  it('can build a provider for exactly the sources declared deployment-scopable', () => {
    // The two facts live in two packages: contracts DECLARES which sources a deployment may own,
    // and this module has to be able to BUILD one for each. Asserting the relation rather than a
    // list, so a new source that is declared scopable and has no way to be constructed fails here
    // instead of at an operator's boot.
    const built = deploymentScopedDocumentProviders().map((provider) => provider.kind)
    expect([...built].sort()).toEqual([...deploymentScopedSources()].sort())
  })

  it('resolves from an environment alone, with no tenant-facing configuration in the way', () => {
    // What `DOCUMENT_SOURCES` governs is which sources a WORKSPACE may connect. Deriving this from
    // that made a deployment which had set its own variables correctly meet a boot refusal naming
    // variables it had already set, so the entry point takes an environment and nothing else.
    const { resolver, configured } = resolveDeploymentDocumentResolver({
      [envKeyFor('notion', new NotionProvider().descriptor.credentialFields[0]!.key)]: 'secret',
    })
    expect(configured).toEqual(['notion'])
    expect(resolver!.configured('notion')).toBe(true)
  })

  it('derives Confluence variable names from the provider, which the docs quote verbatim', () => {
    // `docs/environment-variables.md` and `reusable-operations.md` both spell these out, and both
    // had `_EMAIL` where the derivation produces `_ACCOUNT_EMAIL`: following the doc produced a
    // partial config, an unconfigured source, and a boot error naming variables already set. Pinned
    // here rather than trusted to review, because a doc cannot fail a build.
    const names = new ConfluenceProvider().descriptor.credentialFields.map((field) =>
      envKeyFor('confluence', field.key),
    )
    expect(names).toEqual([
      'DOC_SOURCE_CONFLUENCE_BASE_URL',
      'DOC_SOURCE_CONFLUENCE_ACCOUNT_EMAIL',
      'DOC_SOURCE_CONFLUENCE_API_TOKEN',
    ])
  })
})

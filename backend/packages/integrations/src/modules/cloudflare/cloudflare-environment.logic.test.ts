import type { CloudflareEnvironmentConfig } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  cloudflareConfigToManifest,
  mapDeploymentState,
  parseCloudflareEnvConfig,
  provisionFieldsFor,
  renderNameTemplate,
  resolveCloudflareTarget,
  vcsApiBase,
} from './cloudflare-environment.logic.js'

const BASE: CloudflareEnvironmentConfig = {
  label: 'Cloudflare Workers preview',
  workersSubdomain: 'my-account',
}

describe('cloudflareConfigToManifest / parseCloudflareEnvConfig', () => {
  it('round-trips the config through the stored manifest', () => {
    const config: CloudflareEnvironmentConfig = {
      ...BASE,
      repo: 'acme/widgets',
      defaultTtlMs: 60_000,
    }
    expect(parseCloudflareEnvConfig(cloudflareConfigToManifest(config))).toEqual(config)
  })

  it('defaults the manifest baseUrl to the public API and carries an explicit one through', () => {
    expect(cloudflareConfigToManifest(BASE).baseUrl).toBe('https://api.github.com')
    expect(
      cloudflareConfigToManifest({ ...BASE, apiBaseUrl: 'https://ghes.example.com/api/v3' })
        .baseUrl,
    ).toBe('https://ghes.example.com/api/v3')
  })

  it('rejects a manifest that carries no cloudflare providerConfig', () => {
    const manifest = { ...cloudflareConfigToManifest(BASE), providerConfig: undefined }
    expect(() => parseCloudflareEnvConfig(manifest)).toThrow(/providerConfig/)
  })
})

describe('vcsApiBase', () => {
  it('strips a trailing slash so paths concatenate cleanly', () => {
    expect(vcsApiBase({ ...BASE, apiBaseUrl: 'https://ghes.example.com/api/v3/' })).toBe(
      'https://ghes.example.com/api/v3',
    )
  })
})

describe('renderNameTemplate', () => {
  it('substitutes the provision-context values', () => {
    expect(renderNameTemplate('cat-factory-pr-{{pullNumber}}', { pullNumber: 1413 })).toBe(
      'cat-factory-pr-1413',
    )
  })

  it('folds a branch into characters a hostname label allows', () => {
    // A real branch name carries slashes and uppercase, neither of which may reach a Worker
    // name — leaving them in would produce a URL that cannot resolve.
    expect(
      renderNameTemplate('preview-{{branch}}', { pullNumber: 1, branch: 'Feat/New_Thing' }),
    ).toBe('preview-feat-new-thing')
  })

  it('renders an unknown placeholder EMPTY rather than leaving braces in a name', () => {
    expect(renderNameTemplate('w-{{nope}}-{{pullNumber}}', { pullNumber: 7 })).toBe('w--7')
  })
})

describe('resolveCloudflareTarget', () => {
  const ctx = { pullNumber: 1413, repoOwner: 'acme', repoName: 'widgets', branch: 'feat/x' }

  it('derives the environment, worker and URL from the defaults', () => {
    const result = resolveCloudflareTarget(BASE, ctx)
    expect(result).toEqual({
      ok: true,
      target: {
        owner: 'acme',
        repo: 'widgets',
        environmentName: 'pr-1413',
        workerName: 'cat-factory-pr-1413',
        url: 'https://cat-factory-pr-1413.my-account.workers.dev',
      },
    })
  })

  it('prefers the pinned repo over the block-resolved one', () => {
    const result = resolveCloudflareTarget({ ...BASE, repo: 'other/repo' }, ctx)
    expect(result.ok && result.target).toMatchObject({ owner: 'other', repo: 'repo' })
  })

  it('honours custom name templates', () => {
    const result = resolveCloudflareTarget(
      {
        ...BASE,
        workerNameTemplate: 'app-{{pullNumber}}',
        environmentNameTemplate: 'e-{{pullNumber}}',
      },
      ctx,
    )
    expect(result.ok && result.target).toMatchObject({
      environmentName: 'e-1413',
      workerName: 'app-1413',
      url: 'https://app-1413.my-account.workers.dev',
    })
  })

  // The whole reason this backend exists rather than the manifest it replaces: that manifest
  // interpolated a missing pull number to an empty string, producing environment `pr-` and a
  // URL nothing would ever answer — recorded as a READY environment.
  it.each([
    ['no provision context at all', undefined],
    ['a context with no pull number', { repoOwner: 'acme', repoName: 'widgets' }],
    ['a non-positive pull number', { pullNumber: 0, repoOwner: 'acme', repoName: 'widgets' }],
  ])('refuses %s instead of minting an empty name', (_label, provisionContext) => {
    const result = resolveCloudflareTarget(BASE, provisionContext)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/pull request/i)
  })

  it('refuses when neither a pinned repo nor a block repo is resolvable', () => {
    const result = resolveCloudflareTarget(BASE, { pullNumber: 5 })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/repository/i)
  })
})

describe('mapDeploymentState', () => {
  it('maps success to ready and the failure states to failed', () => {
    expect(mapDeploymentState('success')).toBe('ready')
    expect(mapDeploymentState('failure')).toBe('failed')
    expect(mapDeploymentState('error')).toBe('failed')
  })

  it('maps inactive to torn_down — it is what a teardown posts, not a failure', () => {
    expect(mapDeploymentState('inactive')).toBe('torn_down')
  })

  it('treats an absent or unrecognised state as still provisioning', () => {
    // A vendor adding a state must not turn every live environment red.
    expect(mapDeploymentState(undefined)).toBe('provisioning')
    expect(mapDeploymentState('queued')).toBe('provisioning')
    expect(mapDeploymentState('in_progress')).toBe('provisioning')
    expect(mapDeploymentState('something_new')).toBe('provisioning')
  })
})

describe('provisionFieldsFor', () => {
  it('pins the repository and names so a later status read cannot drift', () => {
    const result = resolveCloudflareTarget(BASE, {
      pullNumber: 9,
      repoOwner: 'acme',
      repoName: 'widgets',
    })
    expect(result.ok && provisionFieldsFor(result.target)).toEqual({
      owner: 'acme',
      repo: 'widgets',
      environmentName: 'pr-9',
      workerName: 'cat-factory-pr-9',
      url: 'https://cat-factory-pr-9.my-account.workers.dev',
    })
  })
})

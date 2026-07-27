import { CLOUDFLARE_ENV_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
import { assertSafeEnvironmentUrl } from '../environments/environments.logic.js'
import {
  CLOUDFLARE_PROVIDER_ID,
  cloudflareConfigToManifest,
  parseCloudflareEnvConfig,
  vcsApiBase,
} from './cloudflare-environment.logic.js'
import { CloudflareEnvironmentProvider } from './CloudflareEnvironmentProvider.js'
// Type-only import of the registry seam so there is no runtime cycle (the same pattern the
// kubernetes backend uses): environment-backends.ts imports this const and registers it;
// this file only borrows the interface shape.
import type { EnvironmentBackendProvider } from '../environments/environment-backends.js'

// Built-in: Cloudflare Workers preview environment backend.
//
// It is a first-class backend rather than a `remote-custom` manifest because everything that
// made the manifest version awkward is structural, not cosmetic: the manifest had to pin ONE
// `owner/repo` and one workers.dev subdomain into a hand-substituted JSON blob, could not read
// a real readiness signal (so it asserted `ready` the moment the deployment record existed),
// and rendered a missing pull number as an empty string — producing an environment named `pr-`
// at a URL that would never resolve. A typed config plus a native provider fixes each of those
// at the source, and the operator picks "Cloudflare Workers" from a list instead of pasting
// JSON and remembering to replace three placeholders.

export const cloudflareEnvironmentBackend: EnvironmentBackendProvider = {
  kind: 'cloudflare',
  displayLabel: 'Cloudflare Workers',
  engines: () => ['cloudflare'],
  // Structural (`'cloudflare' in config`) narrowing rather than `config.kind === 'cloudflare'`:
  // the open contract union carries a generic `{ kind: string, manifest }` custom member whose
  // `kind` can equal any slug, so a kind-equality check no longer narrows it away. The registry
  // routes by slug, so this backend only ever sees its own config.
  referencedSecretKeys: (config) =>
    'cloudflare' in config ? [CLOUDFLARE_ENV_TOKEN_SECRET_KEY] : [],
  connectionMeta: (config) => {
    if (!('cloudflare' in config)) throw new Error('Expected a Cloudflare environment config')
    return {
      providerId: CLOUDFLARE_PROVIDER_ID,
      label: config.cloudflare.label,
      baseUrl: vcsApiBase(config.cloudflare),
    }
  },
  assertConfigSafe: (config, opts) => {
    if (!('cloudflare' in config)) return
    // The VCS API root is the only operator-supplied URL here; the environment URL itself is
    // always a derived public `https://….workers.dev`, so it needs no separate guard.
    assertSafeEnvironmentUrl(
      vcsApiBase(config.cloudflare),
      'VCS API URL',
      opts?.urlPolicy ?? STRICT_URL_SAFETY_POLICY,
    )
  },
  toManifest: (config) => {
    if (!('cloudflare' in config)) throw new Error('Expected a Cloudflare environment config')
    return cloudflareConfigToManifest(config.cloudflare)
  },
  fromManifest: (manifest) => ({
    kind: 'cloudflare',
    cloudflare: parseCloudflareEnvConfig(manifest),
  }),
  buildProvider: (ctx) =>
    new CloudflareEnvironmentProvider(ctx.urlPolicy ? { urlPolicy: ctx.urlPolicy } : {}),
}

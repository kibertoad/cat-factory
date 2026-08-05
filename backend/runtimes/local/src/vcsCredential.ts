import type { LocalVcsSetup, VcsProvider } from '@cat-factory/kernel'
import { ConflictError, UnavailableError } from '@cat-factory/kernel'
import { localDbPath } from './sqlite/db.js'
import {
  type LocalVcsCredentialStore,
  createLocalVcsCredentialStore,
} from './sqlite/vcsCredentialStore.js'

// The deployment's source-control credential, as ONE live value.
//
// Local mode reaches GitHub/GitLab with a single PAT that is simultaneously the sign-in identity
// and the operational credential (clone, push, open PR/MR, gate on CI, merge). It used to be read
// straight off `process.env` at container-build time by a dozen call sites, which made "no token
// configured" a permanent property of the process: the sign-in screen could send a developer to
// the right token page and then had nowhere to put the result but `.env`, followed by a restart.
//
// This module is the seam that replaces those reads. Every consumer asks it at CALL time, so a
// credential installed from the browser is live immediately, and `onChange` lets the few things
// that CANNOT be resolved per call (a memoised container transport, the gate providers registered
// on the provider registry) re-derive themselves at the moment it changes.
//
// PRECEDENCE: `.env` wins over the stored credential, always. The operator who wrote
// `GITHUB_PAT=` into a file meant it, and a stored value silently shadowing it would make that
// file a lie. The browser flow is therefore offered only while `.env` names none — see
// {@link LocalVcsCredentialSource.installable}.

/** The source-control credential the local deployment operates with. */
export interface LocalVcsCredential {
  provider: VcsProvider
  token: string
  /** Where it came from — the sign-in screen labels a stored credential differently from `.env`. */
  origin: 'env' | 'stored'
}

/** Why the browser install flow is closed, when it is. */
export type VcsInstallBlockedReason =
  /** `.env` already names a PAT; it wins, so installing one would change nothing. */
  | 'env_configured'
  /** No `ENCRYPTION_KEY`, so there is nothing to seal a stored credential with. */
  | 'no_encryption_key'

export interface LocalVcsCredentialSource extends LocalVcsSetup {
  /** The credential to operate with right now, or undefined when the deployment has none. */
  current(): LocalVcsCredential | undefined
  /** The providers whose PAT `.env` configures — the one-click sign-in buttons. */
  envProviders(): VcsProvider[]
  /** Why {@link installable} is empty, when it is; undefined when the flow is open. */
  installBlockedReason(): VcsInstallBlockedReason | undefined
  /** Run `fn` after an install changed the resolved credential. */
  onChange(fn: (credential: LocalVcsCredential | undefined) => void): void
  /** Release the underlying store handle (boot never opened one ⇒ a no-op). */
  close(): void
}

/** Every provider a local deployment can be given a token for. */
const INSTALLABLE_PROVIDERS: readonly VcsProvider[] = ['github', 'gitlab']

/** The env variable holding each provider's PAT. */
const PAT_ENV_VAR: Record<VcsProvider, string> = {
  github: 'GITHUB_PAT',
  gitlab: 'GITLAB_PAT',
}

/** The env-configured credential, preferring GitHub — local mode operates on exactly one. */
function envCredential(env: NodeJS.ProcessEnv): LocalVcsCredential | undefined {
  for (const provider of INSTALLABLE_PROVIDERS) {
    const token = env[PAT_ENV_VAR[provider]]?.trim()
    if (token) return { provider, token, origin: 'env' }
  }
  return undefined
}

/**
 * Open the store lazily and remember the failure, so a broken/unwritable sqlite file costs one
 * attempt rather than one per read, and so a deployment that never installs anything never
 * creates the file at all.
 */
class LazyStore {
  private store: LocalVcsCredentialStore | undefined
  private failed = false

  constructor(private readonly open: () => LocalVcsCredentialStore) {}

  get(): LocalVcsCredentialStore | undefined {
    if (this.store || this.failed) return this.store
    try {
      this.store = this.open()
    } catch {
      // silent-catch-ok: an unopenable local store IS "the deployment has no stored credential",
      // which the caller already renders (the sign-in screen offers to install one). The `.env`
      // path is unaffected, so failing the boot over it would be strictly worse.
      this.failed = true
    }
    return this.store
  }

  close(): void {
    this.store?.close()
    this.store = undefined
  }
}

/**
 * Build the deployment's credential source from `env` (+ the sealed local store). `storeFactory`
 * is injectable so tests drive an in-memory store without touching the developer's home
 * directory; by default the store lives at `LOCAL_VCS_CREDENTIAL_DB` or
 * `~/.cat-factory/vcs-credential.sqlite`.
 */
export function createLocalVcsCredentialSource(
  env: NodeJS.ProcessEnv,
  storeFactory?: () => LocalVcsCredentialStore,
): LocalVcsCredentialSource {
  const masterKey = env.ENCRYPTION_KEY?.trim()
  const lazy =
    storeFactory || masterKey
      ? new LazyStore(
          storeFactory ??
            (() =>
              createLocalVcsCredentialStore(
                localDbPath(env.LOCAL_VCS_CREDENTIAL_DB, 'vcs-credential.sqlite'),
                masterKey as string,
              )),
        )
      : undefined
  const listeners: ((credential: LocalVcsCredential | undefined) => void)[] = []
  // The resolved credential is cached because it is read on hot paths (every dispatch, every
  // gate probe, every clone-URL build) and a sqlite read + AES open per call would be waste. It
  // is invalidated on install — the only thing that can change it — so the cache can never be
  // the reason a freshly installed token is not seen.
  let cached: LocalVcsCredential | undefined | null = null

  const resolve = (): LocalVcsCredential | undefined => {
    if (cached !== null) return cached
    const fromEnv = envCredential(env)
    if (fromEnv) {
      cached = fromEnv
      return cached
    }
    const stored = lazy?.get()?.read()
    cached = stored
      ? { provider: stored.provider, token: stored.token, origin: 'stored' }
      : undefined
    return cached
  }

  const blockedReason = (): VcsInstallBlockedReason | undefined => {
    if (envCredential(env)) return 'env_configured'
    if (!lazy) return 'no_encryption_key'
    return undefined
  }

  return {
    current: resolve,
    envProviders: () => INSTALLABLE_PROVIDERS.filter((p) => !!env[PAT_ENV_VAR[p]]?.trim()),
    installBlockedReason: blockedReason,
    // Open while `.env` names no PAT — INCLUDING when a credential is already stored. The stored
    // one can expire or be revoked, and the sign-in screen is the only surface a locked-out
    // developer can reach, so refusing to replace it would recreate the dead end this exists to
    // remove. It grants nothing extra: anyone who can reach that screen can already sign in with
    // the stored token in one click.
    installable: () => (blockedReason() ? [] : [...INSTALLABLE_PROVIDERS]),
    // Both refusals are unreachable through the sign-in screen, which offers the box only for a
    // provider `installable()` names. They are the port's own guard for any other caller, and
    // they refuse by STATUS CLASS with no `details.reason`: the generic 409 / 503 copy is exactly
    // right for both (a credential already owned elsewhere; a capability the deployment has not
    // configured), so neither earns a place in the closed reason vocabularies the SPA translates.
    install: async (provider, token, options) => {
      if (blockedReason() === 'env_configured') {
        throw new ConflictError(
          `${PAT_ENV_VAR[provider]} is set in this deployment's environment, so that token is the one in use. Change it there.`,
        )
      }
      const store = lazy?.get()
      if (!store) {
        throw new UnavailableError(
          'This deployment cannot store a source-control token (no ENCRYPTION_KEY is configured).',
        )
      }
      store.write({ provider, token, login: options?.login ?? null })
      cached = null
      const next = resolve()
      for (const listener of listeners) listener(next)
    },
    onChange: (fn) => listeners.push(fn),
    close: () => lazy?.close(),
  }
}

/**
 * The host a GitLab deployment clones/pushes against, derived from `GITLAB_API_BASE`'s host (a
 * self-managed instance) or the public `gitlab.com`. Single source of truth for BOTH the clone URL
 * the server builds (`resolveRepoOrigin`) and the harness host allow-list, so they can never
 * disagree. Returns undefined unless the credential in use is a GitLab one.
 */
export function gitlabVcsHost(
  env: NodeJS.ProcessEnv,
  credential: LocalVcsCredential | undefined,
): string | undefined {
  if (credential?.provider !== 'gitlab') return undefined
  const apiBase = env.GITLAB_API_BASE?.trim()
  if (!apiBase) return 'gitlab.com'
  try {
    return new URL(apiBase).host
  } catch {
    // silent-catch-ok: an unparseable API base is already reported where it is CONFIGURED; here
    // the honest fallback is the public host, which is what an unset value means too.
    return 'gitlab.com'
  }
}

/**
 * The comma-separated host allow-list the harness container is given (`GITHUB_ALLOWED_HOSTS`).
 * The harness rejects any clone/push host not on this list (default github.com), so a GitLab
 * deployment must add its host or every clone is refused. Combines any operator-set
 * `GITHUB_ALLOWED_HOSTS` with the host the CURRENT credential clones from. Returns undefined when
 * neither applies (GitHub mode with no extra hosts ⇒ the harness keeps its github.com default).
 */
export function harnessAllowedHosts(
  env: NodeJS.ProcessEnv,
  credential: LocalVcsCredential | undefined,
): string | undefined {
  const hosts = new Set<string>()
  for (const h of (env.GITHUB_ALLOWED_HOSTS ?? '').split(',')) {
    const t = h.trim()
    if (t) hosts.add(t)
  }
  const gitlab = gitlabVcsHost(env, credential)
  if (gitlab) hosts.add(gitlab)
  return hosts.size > 0 ? [...hosts].join(',') : undefined
}

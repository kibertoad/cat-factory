import {
  type GitHubClient,
  type GitHubInstallationRepository,
  UnavailableError,
  VcsCapabilityUnsupportedError,
  type VcsProvider,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// providerRoutingGitHubClient: presents ONE `GitHubClient` to the `github` module
// (installation / sync / service) in a deployment that has BOTH a GitHub App AND
// per-workspace GitLab PAT connections. Every method is keyed by `installationId`
// (which connection's credentials to use), so the router resolves that installation's
// stored `provider` and dispatches to the matching underlying client: the App
// `FetchGitHubClient` for a `github` row, the GitLab-adapted client (a `FetchGitLabClient`
// bridged via `asGitHubClient`) for a `gitlab` row. This keeps `GitHubSyncService` /
// `GitHubInstallationService` and both facades' wiring shape unchanged: the multi-provider
// concern lives entirely behind this one seam (the "provider-routing GitHubClient" design).
//
// It is only used when both providers are configured; a single-provider deployment feeds the
// one client directly, so the router is never in the single-provider hot path.
//
// It is a `Proxy` rather than a hand-written delegate, for the reason its local sibling
// (`runtimes/local/src/vcsClientRouter.ts`) already states: `GitHubClient` is a 53-method port
// that keeps growing, and a delegate that must be edited for each addition fails SILENTLY when
// it isn't. Twenty of those methods are OPTIONAL, which is what makes the failure silent rather
// than loud: omitting one does not even fail to typecheck, it just advertises a capability the
// deployment HAS as absent, and every consumer of an optional method feature-tests. The
// hand-written version omitted eighteen. Only one of the eighteen has a consumer on this client
// today (`getBranchProtection`, read by `GitHubService.checkDefaultBranchProtection`), so the
// harm was one workspace-wide security report reading `capability: 'unavailable'` on a
// dual-provider deployment whose App client could answer it perfectly well. The other seventeen
// were latent: this client fronts the `github` module only, and the engine's review/rebase/
// RepoFiles consumers deliberately hold the raw App client instead. Forwarding reflectively
// makes both the fixed case and the latent ones structural.
//
// The two provider-discovery methods that are NOT installation-keyed route to GitHub: the App
// installation picker (`listInstallations`) and the personal-PAT repo reads
// (`listReposForToken` / `getRepoForToken`, keyed by a GitHub user PAT) are GitHub-App-flow
// concepts with no GitLab-PAT analogue. The GitLab connect flow provisions its connection
// through `VcsPatConnectionService`, never `getInstallation`, so a `gitlab` installation is
// only ever reached through installation-keyed reads/writes here.
// ---------------------------------------------------------------------------

export interface ProviderRoutingGitHubClientDependencies {
  /** Resolves an installation id → its stored `provider` (memoised; see below). */
  installations: GitHubInstallationRepository
  /** The App-backed client for `github` installations (absent in a GitLab-only deployment). */
  github?: GitHubClient
  /** The GitLab-adapted client for `gitlab` installations (absent when GitLab connect is off). */
  gitlab?: GitHubClient
}

/**
 * The members that are NOT installation-keyed and therefore always route to the GitHub client:
 * App installation discovery plus the two user-PAT repo reads. Everything else on the port takes
 * `installationId` as its first argument, which is the routing key.
 */
const GITHUB_ONLY_MEMBERS = new Set<string>([
  'listInstallations',
  'listReposForToken',
  'getRepoForToken',
])

/**
 * Property names the router must never route, even when a backing client happens to define one,
 * because the LANGUAGE reads them as protocol rather than as a port method. They are answered by
 * the proxy TARGET instead (see the `get` trap).
 *
 * `then` is the one that bites: an object with a callable `then` is a thenable, so `await client`
 * or returning the client from an `async` function makes the promise machinery call it with
 * `(resolve, reject)`. Routing that call by its first argument would treat `resolve` as an
 * installation id. `toJSON` is the same shape for a serializing logger, and a symbol key
 * (`Symbol.toPrimitive`, `util.inspect.custom`) is never a port method.
 */
function isProtocolKey(property: string | symbol): boolean {
  return typeof property === 'symbol' || property === 'then' || property === 'toJSON'
}

/**
 * Whether `client` implements `property` as a PORT member: the ONE definition of membership the
 * router has, so reading a member and testing for one can never answer differently.
 *
 * It walks the prototype chain, because the backing clients are CLASSES whose methods live on the
 * prototype rather than as own properties, and stops BEFORE `Object.prototype`. That stop is the
 * whole point. A bare `Reflect.has` / `in` keeps walking, so `toString`, `valueOf`, `constructor`,
 * `hasOwnProperty` and the rest of `Object.prototype` all answer true and the router hands back an
 * installation-routing function for each of them. Any string coercion of the client (a template
 * literal, `String(client)`, a logger rendering it) then calls `toString()` with NO arguments: the
 * router reads `args[0]` as the installation id, fires an installation read nobody awaits, and
 * returns a promise where a primitive was required, so the coercion dies as
 * `TypeError: Cannot convert object to primitive value` with an unhandled rejection behind it.
 *
 * {@link isProtocolKey} cannot carry this rule: these are ordinary string keys, and enumerating
 * them by hand would pass today and silently miss whatever `Object.prototype` gains next. The
 * prototype BOUNDARY holds for names nobody has thought of.
 */
function implementsPortMember(client: object, property: string): boolean {
  for (
    let level: object | null = client;
    level !== null && level !== Object.prototype;
    level = Reflect.getPrototypeOf(level)
  ) {
    if (Object.hasOwn(level, property)) return true
  }
  return false
}

/**
 * Build the provider-routing `GitHubClient`. Reflective, so the surface it presents is exactly
 * the union of what the configured backing clients implement: an optional port method that
 * NEITHER client has stays absent (callers feature-test and degrade, which is the truth), and
 * one that at least one client has is advertised, because whether it works is a fact about the
 * INSTALLATION rather than about the router.
 *
 * A call that lands on a provider whose client does not implement the method REFUSES by name
 * ({@link UnavailableError} with a `reason` naming the provider and the method) instead of
 * failing as `undefined is not a function` deep inside a gate probe. That distinction is the
 * point: "this deployment wired no such capability" and "this provider does not offer it" need
 * different fixes, and only the second is true here.
 */
export function providerRoutingGitHubClient(
  deps: ProviderRoutingGitHubClientDependencies,
): GitHubClient {
  // An installation's provider is IMMUTABLE for the connection's lifetime: a workspace that
  // reconnects under a different provider gets a different installation id (a real GitHub id vs
  // the GitLab synthetic id), and a GitLab reconnect keeps the same synthetic id + provider. So
  // this is a memo of a fixed identity fact, NOT a cache of mutable domain state: it can never
  // serve a stale value the way the banned homebrew TTL caches can. It exists to keep the
  // per-repo sync loops (which issue many installation-keyed calls for one installation) from
  // re-reading the installation row on every call, the N+1 the router would otherwise add.
  const providerById = new Map<number, VcsProvider>()

  async function providerOf(installationId: number): Promise<VcsProvider> {
    const memo = providerById.get(installationId)
    if (memo) return memo
    const row = await deps.installations.getByInstallationId(installationId)
    if (!row) {
      // Unknown installation → treat as GitHub (the legacy/backstop default the projection column
      // also uses), so a call for an id we can't resolve routes to the App client rather than
      // throwing. Do NOT memoise this fallback: the row may simply not exist YET (a connection
      // created after this client was built — the router is a long-lived singleton on Node), and
      // caching 'github' for it would pin the wrong provider for the process lifetime. Only a
      // resolved row's provider — an immutable identity — is safe to memoise.
      return 'github'
    }
    providerById.set(installationId, row.provider)
    return row.provider
  }

  /**
   * The member of `client` named `property`, bound, or undefined when it does not implement it.
   * Gated on {@link implementsPortMember} so that "what counts as a member" is decided in ONE
   * place: reading through and testing for a member by different rules is how an inherited
   * `Object.prototype` key becomes a callable route.
   */
  function memberOf(client: GitHubClient | undefined, property: string): unknown {
    if (!client || !implementsPortMember(client, property)) return undefined
    const member = Reflect.get(client as object, property, client)
    return typeof member === 'function'
      ? (member as (...a: unknown[]) => unknown).bind(client)
      : member
  }

  function refuse(provider: VcsProvider, property: string): never {
    throw new VcsCapabilityUnsupportedError(provider, property)
  }

  /** Whether any configured backing client implements `property`. */
  function anyImplements(property: string): boolean {
    return (
      (deps.github !== undefined && implementsPortMember(deps.github, property)) ||
      (deps.gitlab !== undefined && implementsPortMember(deps.gitlab, property))
    )
  }

  return new Proxy({} as GitHubClient, {
    // Anything that is not a port member is answered by the plain proxy TARGET rather than with a
    // hard `undefined`, and the two cases that reach it need exactly that. An optional port method
    // neither client implements is absent on `{}`, so a feature-testing caller still sees
    // `undefined` and degrades. A name the language owns resolves to `Object.prototype`'s own
    // implementation, so coercing, inspecting or logging the client behaves as it does for any
    // object. Answering `undefined` there instead would leave the client with no callable
    // `toString`/`valueOf` at all, which fails string coercion just as loudly as routing them did.
    get(_target, property, receiver) {
      if (isProtocolKey(property)) return Reflect.get(_target, property, receiver)
      const name = property as string

      if (GITHUB_ONLY_MEMBERS.has(name)) {
        // Not installation-keyed, so there is nothing to resolve: expose exactly what the App
        // client exposes. A GitLab-only deployment never reaches these (the router is only wired
        // when both are configured), but a GitHub client that omits an optional one must keep
        // reading as omitted here.
        const member = memberOf(deps.github, name)
        if (member !== undefined) return member
        if (!deps.github && name === 'listInstallations') {
          // Required on the port, so it must stay callable rather than vanish; refusing by name
          // beats the `undefined is not a function` a missing required method would produce.
          return () => refuse('github', name)
        }
        return undefined
      }

      if (!anyImplements(name)) return Reflect.get(_target, property, receiver)

      // Installation-keyed: the first argument is the routing key for every remaining member of
      // the port. Async because resolving the provider is a repository read.
      return async (...args: unknown[]) => {
        const installationId = args[0] as number
        const provider = await providerOf(installationId)
        const client = provider === 'gitlab' ? deps.gitlab : deps.github
        if (!client) {
          throw new UnavailableError(
            `No ${provider} client is configured for installation ${installationId}`,
            'vcs_client_unconfigured',
            { provider },
          )
        }
        const member = memberOf(client, name)
        if (typeof member !== 'function') refuse(provider, name)
        return (member as (...a: unknown[]) => unknown)(...args)
      }
    },

    // Mirrors `get`: a non-member reports whatever the target reports, so an unimplemented
    // optional port method is absent (the feature-test callers rely on) while `'toString' in
    // client` stays true, as it is for every object.
    has(_target, property) {
      if (isProtocolKey(property)) return Reflect.has(_target, property)
      const name = property as string
      if (GITHUB_ONLY_MEMBERS.has(name)) {
        return deps.github !== undefined && implementsPortMember(deps.github, name)
      }
      return anyImplements(name) || Reflect.has(_target, property)
    },
  })
}

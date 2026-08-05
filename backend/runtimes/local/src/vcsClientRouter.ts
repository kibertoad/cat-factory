import type { GitHubClient } from '@cat-factory/kernel'
import { noVcsCredentialError } from './github.js'

// One `GitHubClient` whose backing client is chosen PER CALL from the deployment's current
// source-control credential.
//
// Local mode is single-provider, but which provider that is stops being a boot-time fact once a
// credential can be installed from the sign-in screen: a deployment that booted with nothing can
// become a GitHub one or a GitLab one, and the layers above hold the client object they were
// handed at build time. So the object has to be the stable one and the routing has to be inside
// it.
//
// It is a `Proxy` rather than a hand-written delegate on purpose. `GitHubClient` is a 40-method
// port that keeps growing, and a delegate that has to be edited for each addition fails SILENTLY
// when it isn't: the method resolves on neither client and a caller gets `undefined is not a
// function` on whichever path first uses it. Forwarding reflectively cannot drift.
// (`ProviderRoutingGitHubClient` in @cat-factory/server IS that hand-written delegate, and its
// routing key — an installation row's immutable stored provider — is a different question from
// this one, so it is not the seam to reuse here.)

/**
 * A `GitHubClient` that forwards every call to `resolve()`'s answer at call time. When `resolve`
 * answers undefined the deployment holds no credential, and every member is a function that
 * REFUSES with {@link noVcsCredentialError} — the named, actionable cause — rather than resolving
 * to `undefined` and surfacing as a type error deep in a gate probe.
 *
 * `has` reports the resolved client's own members, so the optional parts of the port
 * (`listReposForToken`, `getRepoForToken`, `listSubIssues`) are advertised exactly as the backing
 * client advertises them: the GitLab adapter omits them and callers that feature-test with `in`
 * must keep seeing that.
 */
export function credentialRoutedGitHubClient(
  resolve: () => GitHubClient | undefined,
): GitHubClient {
  return new Proxy({} as GitHubClient, {
    get(_target, property) {
      const client = resolve()
      if (!client) {
        // A REJECTED promise, not a synchronous throw: every member of the port is an async
        // method, so callers hold the failure with `await` / `.catch`. Throwing synchronously
        // would escape a `.catch()` chain and surface as an unhandled exception in whatever
        // happened to call it first.
        return () => Promise.reject(noVcsCredentialError())
      }
      const member = Reflect.get(client as object, property, client)
      return typeof member === 'function' ? member.bind(client) : member
    },
    has(_target, property) {
      const client = resolve()
      return client ? Reflect.has(client as object, property) : false
    },
  })
}

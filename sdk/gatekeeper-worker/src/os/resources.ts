// What this Gatekeeper serves, as the workspace's own resource vocabulary.
//
// One function, in a file of its own, because three callers need the SAME answer and a second
// spelling of the URL pattern would be a resource an account advertises and a bind cannot match:
// the vendor lists it, the account lists it and matches a URL against it, and the resource object
// describes itself with it.

import type { SupportedResource } from './protocol.js'

/**
 * The single resource: the paired cat-factory workspace, named by a pattern over its origin.
 *
 * The pattern is anchored on the deployment's ORIGIN with a wildcard path, which is what makes a
 * board URL a person pastes (`https://cat-factory.example.com/w/…`) bind to this Gatekeeper. It is
 * not `grantable`: there is nothing to grant separately, because the account's access is the
 * provisioning key this Worker already holds.
 */
export function supportedResourceFor(deployment: string): SupportedResource {
  const origin = new URL(deployment).origin
  return {
    urlPattern: `${origin}/*`,
    title: 'cat-factory workspace',
    description:
      'The cat-factory workspace this Gatekeeper is paired with: file tasks, start runs, watch ' +
      'them, and answer the decisions they park on. One Gatekeeper serves one workspace, because ' +
      'the provisioning key it holds is scoped to one.',
    grantable: false,
  }
}

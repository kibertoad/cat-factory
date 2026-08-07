// The Worker entry point, and deliberately the whole of it.
//
// Every route, the Cap'n Web capability surface, the key broker, the delivery receiver and the
// approval inbox live in `@cat-factory/gatekeeper-worker`, which this deployment INSTALLS. What
// stays here is the part that is yours: the policy in `policy.config.ts`, the bindings in
// `wrangler.toml`, and this wiring. Upgrading the machinery is then a dependency bump rather than
// a merge against a file you have edited.
//
// The Durable Object class is re-exported because wrangler resolves `class_name` against the
// Worker's OWN exports: a class the entry module does not name is a binding that fails to deploy.

import { createGatekeeperWorker } from '@cat-factory/gatekeeper-worker'
import { POLICY } from './policy.config'

export { GatekeeperState } from '@cat-factory/gatekeeper-worker'

export default createGatekeeperWorker({ policy: POLICY })

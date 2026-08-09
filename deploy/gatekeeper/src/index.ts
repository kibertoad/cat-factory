// The Worker entry point, and deliberately the whole of it.
//
// Every route, the Cap'n Web capability surface, the Cloudflare OS object model, the key broker,
// the delivery receiver and the approval inbox live in `@cat-factory/gatekeeper-worker`, which this
// deployment INSTALLS. What stays here is the part that is yours: the policy in `policy.config.ts`,
// the bindings in `wrangler.toml`, and this wiring. Upgrading the machinery is then a dependency
// bump rather than a merge against a file you have edited.
//
// Every export below is resolved BY NAME and none of them is optional:
//
//   - `GatekeeperVendor` is the name a Cloudflare OS deployment's `GATEKEEPER_*` service binding
//     targets. Renaming it makes this Worker undiscoverable.
//   - `CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier` are resolved as
//     `ctx.exports.<Name>` while the workspace walks the object model.
//   - `GatekeeperState` is re-exported because wrangler resolves `class_name` against the Worker's
//     OWN exports: a class the entry module does not name is a binding that fails to deploy.
//
// `GET /health` checks all five in one pass, so a missing line here is a refusal that names it
// rather than a workspace that quietly never finishes installing.

import {
  createGatekeeperAccount,
  createGatekeeperResource,
  createGatekeeperVendor,
  createGatekeeperVerifier,
  createGatekeeperWorker,
} from '@cat-factory/gatekeeper-worker'
import { POLICY } from './policy.config'

export { GatekeeperState } from '@cat-factory/gatekeeper-worker'

export const GatekeeperVendor = createGatekeeperVendor({ policy: POLICY })
export const CatFactoryAccount = createGatekeeperAccount({ policy: POLICY })
export const CatFactoryResource = createGatekeeperResource({ policy: POLICY })
export const CatFactoryVerifier = createGatekeeperVerifier()

export default createGatekeeperWorker({ policy: POLICY })

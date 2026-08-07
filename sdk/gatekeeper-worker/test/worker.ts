// The suite's Worker: this package's own factory over the fixture policy, and nothing else.
//
// It is deliberately byte-for-byte the shape `deploy/gatekeeper/src/index.ts` has, so what runs
// under workerd here is what an operator deploys. If this file ever needs a line the template does
// not have, the base is missing a seam.

import { createGatekeeperWorker } from '../src/index.js'
import { FIXTURE_POLICY } from './fixture-policy.js'

export { GatekeeperState } from '../src/index.js'

export default createGatekeeperWorker({ policy: FIXTURE_POLICY })

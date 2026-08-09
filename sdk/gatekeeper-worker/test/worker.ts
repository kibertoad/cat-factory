// The suite's Worker: this package's own factories over the fixture policy, and nothing else.
//
// It is deliberately byte-for-byte the shape `deploy/gatekeeper/src/index.ts` has, so what runs
// under workerd here is what an operator deploys. If this file ever needs a line the template does
// not have, the base is missing a seam. That includes the OS object model's four exports: they are
// resolved by NAME at runtime, so a suite that declared them differently would be testing an
// arrangement no deployment has.

import {
  createGatekeeperAccount,
  createGatekeeperResource,
  createGatekeeperVendor,
  createGatekeeperVerifier,
  createGatekeeperWorker,
} from '../src/index.js'
import { FIXTURE_POLICY } from './fixture-policy.js'

export { GatekeeperState } from '../src/index.js'

export const GatekeeperVendor = createGatekeeperVendor({ policy: FIXTURE_POLICY })
export const CatFactoryAccount = createGatekeeperAccount({ policy: FIXTURE_POLICY })
export const CatFactoryResource = createGatekeeperResource({ policy: FIXTURE_POLICY })
export const CatFactoryVerifier = createGatekeeperVerifier()

export default createGatekeeperWorker({ policy: FIXTURE_POLICY })

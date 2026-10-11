import {
  definePublicDirectorySuite,
  definePublicKeyReachSuite,
  defineWorkspaceAccessSuite,
  defineWorkspaceRbacSuite,
} from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// Workspace-RBAC initiative (slice 2): the membership roster + access-mode persistence must
// round-trip identically on D1 and Postgres.
defineWorkspaceAccessSuite(harness)
// Workspace-RBAC initiative (slice 3): the gate's resolution + viewer write floor + list
// filtering, enforced over the real HTTP gate — identically on D1 and Postgres.
defineWorkspaceRbacSuite(harness)
// Directory-sync slice 2: account-level public-API keys, their workspace reach and the per-request
// workspace resolution, over the real grant rows and the real auth gate.
definePublicKeyReachSuite(harness)
// Directory-sync slice 3: the public directory snapshots and change feed, over HTTP.
definePublicDirectorySuite(harness)

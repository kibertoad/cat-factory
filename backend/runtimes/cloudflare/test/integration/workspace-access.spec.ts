import { defineWorkspaceAccessSuite, defineWorkspaceRbacSuite } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// Workspace-RBAC initiative (slice 2): the membership roster + access-mode persistence must
// round-trip identically on D1 and Postgres.
defineWorkspaceAccessSuite(harness)
// Workspace-RBAC initiative (slice 3): the gate's resolution + viewer write floor + list
// filtering, enforced over the real HTTP gate — identically on D1 and Postgres.
defineWorkspaceRbacSuite(harness)

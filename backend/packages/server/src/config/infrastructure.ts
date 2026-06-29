import type {
  ExecutionBackendKind,
  InfrastructureCapabilities,
  TestEnvBackendKind,
} from '@cat-factory/contracts'

/**
 * Build the deployment's {@link InfrastructureCapabilities} descriptor (surfaced via
 * `/auth/config`). Each facade calls this with the backends IT can build, so the SPA can
 * present a clear "where agents run" selector instead of a bare delegation toggle. Keeping
 * the construction here (rather than inline per facade) is the symmetry guard — all three
 * facades produce the SAME shape.
 *
 * `active` is the DEPLOYMENT DEFAULT only; in local mode the per-workspace delegation
 * booleans decide the effective backend, which the SPA derives from `available` (see the
 * contract comment on `infrastructureCapabilitiesSchema`).
 */
export function buildInfrastructureCapabilities(input: {
  execution: { available: ExecutionBackendKind[]; active: ExecutionBackendKind }
  testEnv: { available: TestEnvBackendKind[]; active: TestEnvBackendKind }
}): InfrastructureCapabilities {
  return {
    execution: { available: input.execution.available, active: input.execution.active },
    testEnv: { available: input.testEnv.available, active: input.testEnv.active },
  }
}

import type {
  ExecutionBackendKind,
  InfrastructureCapabilities,
  TestEnvBackendKind,
} from '@cat-factory/contracts'

/**
 * Whether the deployment ALREADY has a zero-config test-environment backend — one that stands
 * the Tester's dependencies up with NO provider connection to register. Today that is the local
 * in-container `local-compose` (docker-compose inside the run's container), which local mode
 * offers on a Docker-family runtime. When present, a missing ephemeral-environment PROVIDER
 * connection is NOT a setup gap (docker-compose already works out of the box), so the infra-setup
 * "test environment not configured" nag must stay quiet — see `snapshotInfraSetup`. A deployment
 * whose only test-env backend is the `environment-provider` (the Worker, stock Node, and local
 * Apple `container`, which can't nest a Docker daemon) genuinely needs a provider, so the nag
 * still fires there.
 */
export function testEnvHasZeroConfigDefault(caps: InfrastructureCapabilities | undefined): boolean {
  return caps?.testEnv.available.includes('local-compose') ?? false
}

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
  execution: {
    available: ExecutionBackendKind[]
    active: ExecutionBackendKind
    suggestedExecutorImage?: string
  }
  testEnv: { available: TestEnvBackendKind[]; active: TestEnvBackendKind }
  /**
   * Whether this runtime can host a long-lived, browsable frontend preview. A local/node
   * differentiator (they can keep a served app up on a host-reachable URL); the Worker only
   * runs the self-contained UI-test container, so it passes `false`.
   */
  frontendPreview: { supported: boolean }
  /**
   * Whether this deployment supports the account-wide model-family allow/block policy.
   * `true` on Cloudflare / remote Node and in mothership mode; `false` in plain local mode
   * (no account admin to govern a single-developer machine). The SPA hides the policy admin
   * section and the server refuses to store a non-`off` policy when `false`.
   */
  modelPolicy: { supported: boolean }
}): InfrastructureCapabilities {
  return {
    execution: {
      available: input.execution.available,
      active: input.execution.active,
      suggestedExecutorImage: input.execution.suggestedExecutorImage,
    },
    testEnv: { available: input.testEnv.available, active: input.testEnv.active },
    frontendPreview: { supported: input.frontendPreview.supported },
    modelPolicy: { supported: input.modelPolicy.supported },
  }
}

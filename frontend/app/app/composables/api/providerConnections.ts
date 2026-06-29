import {
  describeEnvironmentProviderContract,
  describeRunnerPoolProviderContract,
  getEnvironmentConnectionContract,
  getRunnerPoolConnectionContract,
  registerEnvironmentProviderContract,
  registerRunnerPoolContract,
  testEnvironmentConnectionContract,
  testRunnerPoolConnectionContract,
  unregisterEnvironmentProviderContract,
  unregisterRunnerPoolContract,
  updateEnvironmentSecretsContract,
  updateRunnerPoolSecretsContract,
} from '@cat-factory/contracts'
import type {
  RegisterEnvironmentProviderInput,
  RegisterRunnerPoolInput,
  TestEnvironmentConnectionInput,
  TestRunnerPoolConnectionInput,
} from '@cat-factory/contracts'
import type {
  ProviderConnectionKind,
  RegisterProviderInput,
  TestProviderInput,
} from '~/types/providerConnections'
import type { ApiContext } from './context'

// The two infrastructure providers share an identical REST surface, differing only in the
// path segment (`environments` vs `runner-pool`). The contracts split into per-kind names,
// so a small lookup table maps each kind to its four contracts; one factory then serves both
// so a single generic store + connect form drives either.
const CONTRACTS = {
  environment: {
    describe: describeEnvironmentProviderContract,
    get: getEnvironmentConnectionContract,
    register: registerEnvironmentProviderContract,
    updateSecrets: updateEnvironmentSecretsContract,
    test: testEnvironmentConnectionContract,
    unregister: unregisterEnvironmentProviderContract,
  },
  'runner-pool': {
    describe: describeRunnerPoolProviderContract,
    get: getRunnerPoolConnectionContract,
    register: registerRunnerPoolContract,
    updateSecrets: updateRunnerPoolSecretsContract,
    test: testRunnerPoolConnectionContract,
    unregister: unregisterRunnerPoolContract,
  },
} satisfies Record<ProviderConnectionKind, unknown>

/** Environment-provider + runner-pool connection endpoints (self-describe + register/test). */
export function providerConnectionsApi({ send, ws }: ApiContext) {
  return {
    // `backendKind` (optional) describes a REGISTERED backend that isn't connected yet, so a
    // custom kind's connect form renders before the first connect. Omitted ⇒ the stored kind.
    // Branch on the kind so `send` sees a single concrete contract (a union contract can't
    // type-check the optional `queryParams`).
    describeProvider: (workspaceId: string, kind: ProviderConnectionKind, backendKind?: string) =>
      kind === 'environment'
        ? send(CONTRACTS.environment.describe, {
            pathPrefix: ws(workspaceId),
            queryParams: { kind: backendKind },
          })
        : send(CONTRACTS['runner-pool'].describe, {
            pathPrefix: ws(workspaceId),
            queryParams: { kind: backendKind },
          }),

    getProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      send(CONTRACTS[kind].get, { pathPrefix: ws(workspaceId) }),

    // The connect form builds the manifest dynamically from a server-provided scaffold, so
    // the FE input keeps `manifest`/`config` opaque (`Record<string, unknown>`); narrow on
    // the kind and cast to the matching per-kind contract input at this single boundary (the
    // backend re-validates against the precise contract on receipt). The runner-pool provider
    // takes a discriminated `config`; a bare `manifest` is wrapped into the manifest backend.
    registerProviderConnection: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      body: RegisterProviderInput,
    ) =>
      kind === 'environment'
        ? send(CONTRACTS.environment.register, {
            pathPrefix: ws(workspaceId),
            body: {
              config: backendConfig(body),
              secrets: body.secrets,
            } as RegisterEnvironmentProviderInput,
          })
        : send(CONTRACTS['runner-pool'].register, {
            pathPrefix: ws(workspaceId),
            body: {
              config: backendConfig(body),
              secrets: body.secrets,
            } as RegisterRunnerPoolInput,
          }),

    updateProviderSecrets: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      secrets: Record<string, string>,
    ) => send(CONTRACTS[kind].updateSecrets, { pathPrefix: ws(workspaceId), body: { secrets } }),

    testProviderConnection: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      body: TestProviderInput,
    ) =>
      kind === 'environment'
        ? send(CONTRACTS.environment.test, {
            pathPrefix: ws(workspaceId),
            body: {
              ...(body.manifest || body.config ? { config: backendConfig(body) } : {}),
              ...(body.secrets ? { secrets: body.secrets } : {}),
            } as TestEnvironmentConnectionInput,
          })
        : send(CONTRACTS['runner-pool'].test, {
            pathPrefix: ws(workspaceId),
            body: {
              ...(body.manifest || body.config ? { config: backendConfig(body) } : {}),
              ...(body.secrets ? { secrets: body.secrets } : {}),
            } as TestRunnerPoolConnectionInput,
          }),

    deleteProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      send(CONTRACTS[kind].unregister, { pathPrefix: ws(workspaceId) }),
  }
}

/**
 * Resolve the discriminated backend config (runner-pool OR environment) from a connect-form
 * payload: an explicit `config` (the Kubernetes form) wins; otherwise a bare `manifest` (the
 * flat form / manifest editor) is wrapped into the selected backend kind — `body.backendKind`
 * (a built-in `manifest` or a registered CUSTOM slug), defaulting to `manifest`. A custom kind
 * MUST carry its slug here, else its flat-form save would be mis-tagged as the manifest backend.
 */
function backendConfig(body: RegisterProviderInput | TestProviderInput): Record<string, unknown> {
  if (body.config) return body.config
  return { kind: body.backendKind ?? 'manifest', manifest: body.manifest ?? {} }
}

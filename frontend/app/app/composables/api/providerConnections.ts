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
    describeProvider: (workspaceId: string, kind: ProviderConnectionKind) =>
      send(CONTRACTS[kind].describe, { pathPrefix: ws(workspaceId) }),

    getProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      send(CONTRACTS[kind].get, { pathPrefix: ws(workspaceId) }),

    // The connect form builds the manifest dynamically from a server-provided scaffold, so
    // the FE input keeps `manifest` opaque (`Record<string, unknown>`); narrow on the kind
    // and cast to the matching per-kind contract input at this single boundary (the backend
    // re-validates the manifest against the precise contract on receipt).
    registerProviderConnection: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      body: RegisterProviderInput,
    ) =>
      kind === 'environment'
        ? send(CONTRACTS.environment.register, {
            pathPrefix: ws(workspaceId),
            body: body as RegisterEnvironmentProviderInput,
          })
        : send(CONTRACTS['runner-pool'].register, {
            pathPrefix: ws(workspaceId),
            body: body as RegisterRunnerPoolInput,
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
            body: body as TestEnvironmentConnectionInput,
          })
        : send(CONTRACTS['runner-pool'].test, {
            pathPrefix: ws(workspaceId),
            body: body as TestRunnerPoolConnectionInput,
          }),

    deleteProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      send(CONTRACTS[kind].unregister, { pathPrefix: ws(workspaceId) }),
  }
}

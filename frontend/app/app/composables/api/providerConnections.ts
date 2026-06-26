import type {
  ConnectionTestResult,
  ProviderConnection,
  ProviderConnectionKind,
  ProviderDescriptor,
  RegisterProviderInput,
  TestProviderInput,
} from '~/types/providerConnections'
import type { ApiContext } from './context'

// The two infrastructure providers share an identical REST surface, differing only in the
// path segment (`environments` vs `runner-pool`). One factory serves both so a single
// generic store + connect form drives either.
const SEGMENT: Record<ProviderConnectionKind, string> = {
  environment: 'environments',
  'runner-pool': 'runner-pool',
}

/** Environment-provider + runner-pool connection endpoints (self-describe + register/test). */
export function providerConnectionsApi({ http, ws }: ApiContext) {
  const base = (workspaceId: string, kind: ProviderConnectionKind) =>
    `${ws(workspaceId)}/${SEGMENT[kind]}`

  return {
    describeProvider: (workspaceId: string, kind: ProviderConnectionKind) =>
      http<ProviderDescriptor>(`${base(workspaceId, kind)}/provider`),

    getProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      http<{ connection: ProviderConnection | null }>(`${base(workspaceId, kind)}/connection`),

    registerProviderConnection: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      body: RegisterProviderInput,
    ) =>
      http<ProviderConnection>(`${base(workspaceId, kind)}/connection`, { method: 'POST', body }),

    updateProviderSecrets: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      secrets: Record<string, string>,
    ) =>
      http<ProviderConnection>(`${base(workspaceId, kind)}/connection/secrets`, {
        method: 'PUT',
        body: { secrets },
      }),

    testProviderConnection: (
      workspaceId: string,
      kind: ProviderConnectionKind,
      body: TestProviderInput,
    ) =>
      http<ConnectionTestResult>(`${base(workspaceId, kind)}/connection/test`, {
        method: 'POST',
        body,
      }),

    deleteProviderConnection: (workspaceId: string, kind: ProviderConnectionKind) =>
      http(`${base(workspaceId, kind)}/connection`, { method: 'DELETE' }),
  }
}

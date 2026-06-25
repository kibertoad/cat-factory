import type {
  ConnectionTestResult,
  StoreUserSecretInput,
  TestUserSecretInput,
  UserSecretDescriptor,
  UserSecretKind,
  UserSecretStatus,
} from '~/types/userSecrets'
import type { ApiContext } from './context'

// Per-USER generic secrets (a GitHub PAT today). User-scoped (no workspace); the secret
// is write-only server-side and never returned — only status metadata + a `hasSecret`
// flag. `descriptors` drive the generic connect form; `test` probes before save.
export function userSecretsApi({ http }: ApiContext) {
  return {
    listUserSecrets: () =>
      http<{ secrets: UserSecretStatus[]; descriptors: UserSecretDescriptor[] }>('/user-secrets'),

    storeUserSecret: (kind: UserSecretKind, body: StoreUserSecretInput) =>
      http<UserSecretStatus>(`/user-secrets/${encodeURIComponent(kind)}`, { method: 'POST', body }),

    deleteUserSecret: (kind: UserSecretKind) =>
      http(`/user-secrets/${encodeURIComponent(kind)}`, { method: 'DELETE' }),

    testUserSecret: (kind: UserSecretKind, body: TestUserSecretInput) =>
      http<ConnectionTestResult>(`/user-secrets/${encodeURIComponent(kind)}/test`, {
        method: 'POST',
        body,
      }),
  }
}

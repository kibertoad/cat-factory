import {
  listUserSecretsContract,
  removeUserSecretContract,
  storeUserSecretContract,
  testUserSecretContract,
} from '@cat-factory/contracts'
import type { StoreUserSecretInput, TestUserSecretInput, UserSecretKind } from '~/types/userSecrets'
import type { ApiContext } from './context'

// Per-USER generic secrets (a GitHub PAT today). User-scoped (no workspace); the secret
// is write-only server-side and never returned — only status metadata + a `hasSecret`
// flag. `descriptors` drive the generic connect form; `test` probes before save.
export function userSecretsApi({ send }: ApiContext) {
  return {
    listUserSecrets: () => send(listUserSecretsContract, {}),

    storeUserSecret: (kind: UserSecretKind, body: StoreUserSecretInput) =>
      send(storeUserSecretContract, { pathParams: { kind }, body }),

    deleteUserSecret: (kind: UserSecretKind) =>
      send(removeUserSecretContract, { pathParams: { kind } }),

    testUserSecret: (kind: UserSecretKind, body: TestUserSecretInput) =>
      send(testUserSecretContract, { pathParams: { kind }, body }),
  }
}

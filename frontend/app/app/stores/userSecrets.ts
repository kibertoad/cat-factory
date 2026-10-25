import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isAbsentFeatureRefusal } from '~/composables/api/errors'
import type {
  ConnectionTestResult,
  StoreUserSecretInput,
  TestUserSecretInput,
  UserSecretDescriptor,
  UserSecretKind,
  UserSecretStatus,
} from '~/types/userSecrets'

// The signed-in user's generic secrets (a GitHub PAT today). Stored PER USER (a run you
// initiate uses YOUR GitHub access), write-only server-side — this store carries only the
// status metadata + a `hasSecret` flag, plus the kind descriptors that drive the generic
// connect form. Loaded INDEPENDENTLY of the workspace snapshot, like local runners.
export const useUserSecretsStore = defineStore('userSecrets', () => {
  const api = useApi()
  const secrets = ref<UserSecretStatus[]>([])
  const descriptors = ref<UserSecretDescriptor[]>([])
  const loading = ref(false)
  /** True when the last `load()` failed for a reason other than auth or the feature being off. */
  const loadFailed = ref(false)

  async function load() {
    loading.value = true
    try {
      const { secrets: list, descriptors: descs } = await api.listUserSecrets()
      secrets.value = list
      descriptors.value = descs
      loadFailed.value = false
    } catch (err) {
      // Auth disabled / not signed in (401) or feature off (503) → nothing to surface. Any
      // other failure is recorded, so a reader can tell it from an empty list.
      loadFailed.value = !isAbsentFeatureRefusal(err)
      secrets.value = []
      descriptors.value = []
    } finally {
      loading.value = false
    }
  }

  function statusFor(kind: UserSecretKind): UserSecretStatus | undefined {
    return secrets.value.find((s) => s.kind === kind)
  }

  function descriptorFor(kind: UserSecretKind): UserSecretDescriptor | undefined {
    return descriptors.value.find((d) => d.kind === kind)
  }

  async function store(kind: UserSecretKind, input: StoreUserSecretInput) {
    const status = await api.storeUserSecret(kind, input)
    secrets.value = [...secrets.value.filter((s) => s.kind !== kind), status]
    return status
  }

  async function remove(kind: UserSecretKind) {
    await api.deleteUserSecret(kind)
    secrets.value = secrets.value.filter((s) => s.kind !== kind)
  }

  async function test(
    kind: UserSecretKind,
    input: TestUserSecretInput,
  ): Promise<ConnectionTestResult> {
    return await api.testUserSecret(kind, input)
  }

  return {
    secrets,
    descriptors,
    loading,
    loadFailed,
    load,
    statusFor,
    descriptorFor,
    store,
    remove,
    test,
  }
})

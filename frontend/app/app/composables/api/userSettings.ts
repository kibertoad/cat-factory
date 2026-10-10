import { getUserSettingsContract, updateUserSettingsContract } from '@cat-factory/contracts'
import type { UpdateUserSettingsInput } from '~/types/domain'
import type { ApiContext } from './context'

/** Per-user settings (the user-tier spend budget), scoped to the signed-in user. */
export function userSettingsApi({ send }: ApiContext) {
  return {
    getUserSettings: () => send(getUserSettingsContract, {}),
    updateUserSettings: (body: UpdateUserSettingsInput) =>
      send(updateUserSettingsContract, { body }),
  }
}

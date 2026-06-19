import type { EnvironmentsConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { EnvironmentsConfig }

export function loadEnvironmentsConfig(env: Env): EnvironmentsConfig {
  return {
    enabled: env.ENVIRONMENTS_ENABLED === 'true' && !!env.ENVIRONMENTS_ENCRYPTION_KEY,
    encryptionKey: env.ENVIRONMENTS_ENCRYPTION_KEY,
  }
}

import type { EnvironmentsConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { EnvironmentsConfig }

export function loadEnvironmentsConfig(env: Env): EnvironmentsConfig {
  // Opt-in via the enable flag; credentials are sealed with the shared ENCRYPTION_KEY
  // (under an environments-scoped HKDF info).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.ENVIRONMENTS_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
  }
}

import type { RunnerPoolConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { RunnerPoolConfig }

export function loadRunnerPoolConfig(env: Env): RunnerPoolConfig {
  // Opt-in via the enable flag; scheduler secrets are sealed with the shared
  // ENCRYPTION_KEY (under a runners-scoped HKDF info).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.RUNNERS_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
  }
}

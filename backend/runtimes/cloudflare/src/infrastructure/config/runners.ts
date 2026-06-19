import type { RunnerPoolConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { RunnerPoolConfig }

export function loadRunnerPoolConfig(env: Env): RunnerPoolConfig {
  return {
    enabled: env.RUNNERS_ENABLED === 'true' && !!env.RUNNERS_ENCRYPTION_KEY,
    encryptionKey: env.RUNNERS_ENCRYPTION_KEY,
  }
}

import type { RunnerPoolConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { csv } from './utils'

export type { RunnerPoolConfig }

export function loadRunnerPoolConfig(env: Env): RunnerPoolConfig {
  // Opt-in via the enable flag; scheduler secrets are sealed with the shared
  // ENCRYPTION_KEY (under a runners-scoped HKDF info).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.RUNNERS_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
    allowUrlHosts: csv(env.RUNNERS_ALLOW_URL_HOSTS),
    allowHttpUrls: env.RUNNERS_ALLOW_HTTP_URLS === 'true',
  }
}

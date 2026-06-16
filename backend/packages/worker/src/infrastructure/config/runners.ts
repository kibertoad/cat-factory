import type { Env } from '../env'

export interface RunnerPoolConfig {
  /**
   * Opt-in flag. Requires `RUNNERS_ENCRYPTION_KEY` to be set: per-tenant
   * scheduler-API credentials are always stored encrypted, so the feature refuses
   * to assemble without a master key (never a silent plaintext fallback).
   */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
  encryptionKey?: string
}

export function loadRunnerPoolConfig(env: Env): RunnerPoolConfig {
  return {
    enabled: env.RUNNERS_ENABLED === 'true' && !!env.RUNNERS_ENCRYPTION_KEY,
    encryptionKey: env.RUNNERS_ENCRYPTION_KEY,
  }
}

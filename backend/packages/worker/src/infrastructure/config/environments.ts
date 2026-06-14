import type { Env } from '../env'

export interface EnvironmentsConfig {
  /**
   * Opt-in flag. Requires `ENVIRONMENTS_ENCRYPTION_KEY` to be set: per-tenant
   * credentials are always stored encrypted, so the feature refuses to assemble
   * without a master key (never a silent plaintext fallback).
   */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
  encryptionKey?: string
}

export function loadEnvironmentsConfig(env: Env): EnvironmentsConfig {
  return {
    enabled: env.ENVIRONMENTS_ENABLED === 'true' && !!env.ENVIRONMENTS_ENCRYPTION_KEY,
    encryptionKey: env.ENVIRONMENTS_ENCRYPTION_KEY,
  }
}

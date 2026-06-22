import type { LangfuseConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { LangfuseConfig }

/**
 * Langfuse trace-sink config. Opt-in: off unless `LANGFUSE_ENABLED=true` AND both keys
 * are present (a half-configured sink silently does nothing, like the other opt-in
 * integrations). `LANGFUSE_BASE_URL` is optional and defaults to Langfuse Cloud.
 */
export function loadLangfuseConfig(env: Env): LangfuseConfig {
  const enabled =
    env.LANGFUSE_ENABLED?.trim() === 'true' &&
    !!env.LANGFUSE_PUBLIC_KEY?.trim() &&
    !!env.LANGFUSE_SECRET_KEY?.trim()
  return {
    enabled,
    publicKey: env.LANGFUSE_PUBLIC_KEY?.trim(),
    secretKey: env.LANGFUSE_SECRET_KEY?.trim(),
    baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
  }
}

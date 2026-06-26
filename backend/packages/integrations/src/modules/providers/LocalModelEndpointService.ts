import type {
  Clock,
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { getErrorMessage, ValidationError } from '@cat-factory/kernel'
import type {
  LocalModelEndpoint,
  LocalModelEndpointTestResult,
  LocalRunner,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '@cat-factory/contracts'
import { LOCAL_RUNNER_LABELS } from '@cat-factory/contracts'
import { fetchLocalRunner, localRunnerUrlError } from './localModelUrl.js'

// LocalModelEndpointService: owns each USER's locally-run model endpoints (Ollama / LM
// Studio / llama.cpp / vLLM / a custom OpenAI-compatible server) — the per-user analogue
// of the workspace API-key pool, but for self-hosted runners. A runner lives on the
// user's own machine, so endpoints are scoped to the user and resolved by the RUN
// INITIATOR at execution time (mirroring personal subscriptions).
//
// The optional bearer key (most local runners ignore auth) is encrypted at rest with the
// system SecretCipher and never returned to the SPA. `testConnection` probes the runner's
// OpenAI-compatible `/models` server-side so the UI can validate a base URL and list the
// models the runner actually serves before the user enables them.

export interface LocalModelEndpointServiceDependencies {
  localModelEndpointRepository: LocalModelEndpointRepository
  /** System encryption layer (master key) for the optional bearer key at rest. */
  secretCipher: SecretCipher
  clock: Clock
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

/** A resolved endpoint for the run-time path: base URL + the decrypted optional key. */
export interface ResolvedLocalEndpoint {
  provider: LocalRunner
  baseUrl: string
  apiKey: string | null
}

export class LocalModelEndpointService {
  constructor(private readonly deps: LocalModelEndpointServiceDependencies) {}

  /** Every endpoint the user has configured (key-free wire shape). */
  async list(userId: string): Promise<LocalModelEndpoint[]> {
    const rows = await this.deps.localModelEndpointRepository.listByUser(userId)
    return rows.map((r) => toWire(r))
  }

  /** Create or replace the user's endpoint for a runner. */
  async upsert(userId: string, input: UpsertLocalModelEndpointInput): Promise<LocalModelEndpoint> {
    // SSRF guard: the stored base URL is later forwarded to server-side (the LLM proxy +
    // inline provider resolve it by the run initiator), so reject a non-local host here at
    // the write boundary — the run-time paths then trust the persisted URL.
    const urlError = localRunnerUrlError(input.baseUrl)
    if (urlError) throw new ValidationError(urlError)
    const now = this.deps.clock.now()
    const existing = await this.deps.localModelEndpointRepository.getByUserProvider(
      userId,
      input.provider,
    )
    // An omitted apiKey keeps the stored one; an explicit empty string clears it.
    const apiKeyCipher =
      input.apiKey === undefined
        ? (existing?.apiKeyCipher ?? null)
        : input.apiKey.length > 0
          ? await this.deps.secretCipher.encrypt(input.apiKey)
          : null
    const record: LocalModelEndpointRecord = {
      userId,
      provider: input.provider,
      label: input.label?.trim() || LOCAL_RUNNER_LABELS[input.provider],
      baseUrl: input.baseUrl,
      apiKeyCipher,
      models: dedupe(input.models),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.localModelEndpointRepository.upsert(record)
    return toWire(record)
  }

  /** Remove the user's endpoint for a runner. */
  async remove(userId: string, provider: LocalRunner): Promise<void> {
    await this.deps.localModelEndpointRepository.remove(userId, provider)
  }

  /**
   * The set of local-runner providers the user has configured with ≥1 enabled model,
   * plus the enabled models per provider — the input to the per-user model catalog.
   */
  async capabilitiesFor(
    userId: string,
  ): Promise<{ provider: LocalRunner; label: string; models: string[] }[]> {
    const rows = await this.deps.localModelEndpointRepository.listByUser(userId)
    return rows
      .filter((r) => r.models.length > 0)
      .map((r) => ({ provider: r.provider, label: r.label, models: r.models }))
  }

  /**
   * Resolve a user's endpoint for run-time forwarding: base URL + decrypted optional key.
   * Used by the LLM proxy, keyed by the run initiator + the locked provider.
   */
  async resolve(userId: string, provider: string): Promise<ResolvedLocalEndpoint | null> {
    const record = await this.deps.localModelEndpointRepository.getByUserProvider(
      userId,
      provider as LocalRunner,
    )
    if (!record) return null
    const apiKey = record.apiKeyCipher
      ? await this.deps.secretCipher.decrypt(record.apiKeyCipher)
      : null
    return { provider: record.provider, baseUrl: record.baseUrl, apiKey }
  }

  /**
   * All of a user's endpoints resolved for run-time forwarding (base URL + decrypted
   * optional key). Used by the inline model provider to register the user's runners.
   */
  async listResolved(userId: string): Promise<ResolvedLocalEndpoint[]> {
    const rows = await this.deps.localModelEndpointRepository.listByUser(userId)
    const out: ResolvedLocalEndpoint[] = []
    for (const record of rows) {
      const apiKey = record.apiKeyCipher
        ? await this.deps.secretCipher.decrypt(record.apiKeyCipher)
        : null
      out.push({ provider: record.provider, baseUrl: record.baseUrl, apiKey })
    }
    return out
  }

  /**
   * Probe a runner's OpenAI-compatible `/models` endpoint server-side, returning
   * reachability + the model ids it serves. Never throws — failures are reported as
   * `{ reachable: false, error }` so the UI can surface them.
   */
  async testConnection(input: TestLocalModelEndpointInput): Promise<LocalModelEndpointTestResult> {
    // SSRF guard: this probe forwards to a user-supplied URL server-side, so refuse a
    // non-local host before issuing the fetch (same allow-list as `upsert`).
    const urlError = localRunnerUrlError(input.baseUrl)
    if (urlError) return { reachable: false, models: [], error: urlError }
    const doFetch = this.deps.fetch ?? fetch
    const url = `${input.baseUrl.replace(/\/+$/, '')}/models`
    try {
      const headers: Record<string, string> = {}
      if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`
      // Re-validate on every redirect hop: a reachable runner that 302s to a denied
      // host (e.g. the cloud-metadata endpoint) must not be followed.
      const res = await fetchLocalRunner(
        url,
        { headers, signal: AbortSignal.timeout(8000) },
        doFetch,
      )
      if (!res.ok) {
        return { reachable: false, models: [], error: `Runner returned HTTP ${res.status}` }
      }
      const body = (await res.json()) as { data?: { id?: unknown }[] }
      const models = Array.isArray(body.data)
        ? body.data.map((m) => String(m?.id ?? '')).filter(Boolean)
        : []
      return { reachable: true, models }
    } catch (err) {
      return { reachable: false, models: [], error: getErrorMessage(err) }
    }
  }
}

function toWire(record: LocalModelEndpointRecord): LocalModelEndpoint {
  return {
    provider: record.provider,
    label: record.label,
    baseUrl: record.baseUrl,
    hasApiKey: record.apiKeyCipher !== null,
    models: record.models,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function dedupe(models: string[]): string[] {
  return [...new Set(models.map((m) => m.trim()).filter(Boolean))]
}

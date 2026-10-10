import type {
  Clock,
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { getErrorMessage, ValidationError } from '@cat-factory/kernel'
import type {
  LocalModelDeclaration,
  LocalModelEndpoint,
  LocalModelEndpointTestResult,
  LocalRunner,
  LocalRunnerUrlReason,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '@cat-factory/contracts'
import { LOCAL_RUNNER_LABELS } from '@cat-factory/contracts'
import {
  fetchLocalRunner,
  type LocalRunnerUrlPolicy,
  type LocalRunnerUrlRefusal,
  localRunnerUrlRefusal,
  runnerRequestUrl,
} from './localModelUrl.js'

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

/**
 * HKDF domain tag separating a local runner's sealed bearer key from every other cipher (mirrors
 * {@link TEST_SECRETS_CIPHER_INFO} et al). Both facades build their `WebCryptoSecretCipher` from
 * this constant: the tag derives the key, so a facade spelling it differently seals credentials
 * its sibling cannot unseal.
 */
export const LOCAL_MODEL_ENDPOINTS_CIPHER_INFO = 'cat-factory:local-model-endpoints'

export interface LocalModelEndpointServiceDependencies {
  localModelEndpointRepository: LocalModelEndpointRepository
  /** System encryption layer (master key) for the optional bearer key at rest. */
  secretCipher: SecretCipher
  clock: Clock
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  /**
   * Permit private-LAN runner hosts (RFC1918 / ULA / mDNS `.local`) in addition to
   * loopback. OFF by default: on a shared multi-tenant deployment the LAN allow-list is
   * an internal-network SSRF grant, so it is an operator opt-in
   * (`LOCAL_MODELS_ALLOW_LAN=true`; single-tenant local mode defaults it on).
   */
  allowPrivateLanHosts?: boolean
}

/** A resolved endpoint for the run-time path: base URL + the decrypted optional key. */
export interface ResolvedLocalEndpoint {
  provider: LocalRunner
  baseUrl: string
  apiKey: string | null
}

export class LocalModelEndpointService {
  /** The deployment's runner-host policy, normalised once from the deps flag. */
  private readonly urlPolicy: LocalRunnerUrlPolicy

  constructor(private readonly deps: LocalModelEndpointServiceDependencies) {
    this.urlPolicy = { allowPrivateLan: deps.allowPrivateLanHosts ?? false }
  }

  /**
   * Every endpoint the user has configured (key-free wire shape), each carrying whether
   * the deployment's CURRENT policy still permits its URL. A row can pre-date a policy
   * narrowing, and an endpoint whose models are withheld from the picker has to say so
   * here or it reads as healthy while every run against it is refused.
   */
  async list(userId: string): Promise<LocalModelEndpoint[]> {
    const rows = await this.deps.localModelEndpointRepository.listByUser(userId)
    return rows.map((r) => toWire(r, this.urlRefusalFor(r.baseUrl)))
  }

  /** The policy verdict on one stored base URL: the reason it is unusable, or null. */
  private urlRefusalFor(baseUrl: string): LocalRunnerUrlReason | null {
    return localRunnerUrlRefusal(baseUrl, this.urlPolicy)?.reason ?? null
  }

  /** Create or replace the user's endpoint for a runner. */
  async upsert(userId: string, input: UpsertLocalModelEndpointInput): Promise<LocalModelEndpoint> {
    // SSRF guard: the stored base URL is later forwarded to server-side (the LLM proxy +
    // inline provider resolve it by the run initiator), so reject a host the deployment's
    // policy denies here at the write boundary. The run-time paths re-validate too (via
    // `fetchRunner`), because a row can pre-date a policy narrowing.
    const urlError = localRunnerUrlRefusal(input.baseUrl, this.urlPolicy)
    if (urlError) throw new ValidationError(urlError.message, { reason: urlError.reason })
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
      // What is about to be stored is exactly what the request validated, so nothing was discarded
      // reading it. This write is also the FIX for a row that did lose entries: it replaces the
      // whole blob, so the next read of it reports clean again.
      unreadableModels: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.localModelEndpointRepository.upsert(record)
    // Just validated above, so the stored row is permitted by construction.
    return toWire(record, null)
  }

  /** Remove the user's endpoint for a runner. */
  async remove(userId: string, provider: LocalRunner): Promise<void> {
    await this.deps.localModelEndpointRepository.remove(userId, provider)
  }

  /**
   * The set of local-runner providers the user has configured with ≥1 enabled model,
   * plus the enabled models per provider: the input to the per-user model catalog. Each model
   * carries the user's own declaration about it, so the picker can state what a local model may
   * be given exactly as it does for a curated one.
   */
  async capabilitiesFor(
    userId: string,
  ): Promise<{ provider: LocalRunner; label: string; models: LocalModelDeclaration[] }[]> {
    const rows = await this.deps.localModelEndpointRepository.listByUser(userId)
    return (
      rows
        .filter((r) => r.models.length > 0)
        // A row the CURRENT policy denies is not offered: admission would price its models as
        // free, dispatch a container, and only then die at the first forward. Withholding it
        // moves the failure to the settings panel (which reports `urlBlockedReason`), where
        // the thing that is actually wrong can be fixed.
        .filter((r) => this.urlRefusalFor(r.baseUrl) === null)
        .map((r) => ({ provider: r.provider, label: r.label, models: r.models }))
    )
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
   * Fetch a runner URL under this deployment's host policy, re-validating the allow-list
   * on every redirect hop. The ONE transport every run-time forward uses (the LLM proxy,
   * the inline model provider, the probe below), so a row persisted under a wider policy
   * is refused loudly at fetch time after an operator narrows it, never silently honoured.
   */
  fetchRunner(rawUrl: string, init: RequestInit): Promise<Response> {
    return fetchLocalRunner(rawUrl, init, this.deps.fetch ?? fetch, this.urlPolicy)
  }

  /**
   * Compose one runner ENDPOINT url (`/models`, `/chat/completions`) from a stored base URL
   * under this deployment's policy. The seam every server-side caller uses instead of
   * appending to `resolved.baseUrl`, so the policy stays here rather than being re-derived
   * (and re-derived differently) at each forward.
   */
  endpointUrl(
    baseUrl: string,
    suffix: `/${string}`,
  ): { url: string } | { refusal: LocalRunnerUrlRefusal } {
    return runnerRequestUrl(baseUrl, suffix, this.urlPolicy)
  }

  /**
   * Probe a runner's OpenAI-compatible `/models` endpoint server-side, returning
   * reachability + the model ids it serves. Never throws — failures are reported as
   * `{ reachable: false, error }` so the UI can surface them.
   */
  async testConnection(input: TestLocalModelEndpointInput): Promise<LocalModelEndpointTestResult> {
    // SSRF guard: this probe forwards to a user-supplied URL server-side, so refuse a host
    // the policy denies before issuing the fetch (same allow-list as `upsert`). Composed
    // rather than concatenated, so the `/models` suffix cannot be discarded by the base.
    const composed = runnerRequestUrl(input.baseUrl, '/models', this.urlPolicy)
    if ('refusal' in composed) {
      return {
        reachable: false,
        models: [],
        error: composed.refusal.message,
        errorReason: composed.refusal.reason,
      }
    }
    const url = composed.url
    try {
      const headers: Record<string, string> = {}
      if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`
      // Re-validate on every redirect hop: a reachable runner that 302s to a denied
      // host (e.g. the cloud-metadata endpoint) must not be followed.
      const res = await this.fetchRunner(url, { headers, signal: AbortSignal.timeout(8000) })
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

function toWire(
  record: LocalModelEndpointRecord,
  urlBlockedReason: LocalRunnerUrlReason | null,
): LocalModelEndpoint {
  return {
    provider: record.provider,
    label: record.label,
    baseUrl: record.baseUrl,
    hasApiKey: record.apiKeyCipher !== null,
    models: record.models,
    unreadableModels: record.unreadableModels,
    urlBlockedReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * One entry per model id, in first-seen order. LAST declaration wins for a repeated id: the panel
 * sends one entry per ticked model, so a duplicate is a client bug rather than a choice, and taking
 * the later one means the value the user set most recently is the one stored.
 */
function dedupe(models: LocalModelDeclaration[]): LocalModelDeclaration[] {
  const byId = new Map<string, LocalModelDeclaration>()
  for (const model of models) {
    const id = model.id.trim()
    if (id) byId.set(id, { ...model, id })
  }
  return [...byId.values()]
}

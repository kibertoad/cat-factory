import type {
  Clock,
  ProviderModelCatalogRecord,
  ProviderModelCatalogRepository,
} from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'
import type {
  OpenRouterCatalog,
  OpenRouterModelMeta,
  OpenRouterRefreshResult,
  UpsertOpenRouterCatalogInput,
} from '@cat-factory/contracts'
import type { ApiKeyService } from './ApiKeyService.js'

// OpenRouterCatalogService: owns each WORKSPACE's enabled OpenRouter models — the
// workspace-scoped analogue of the per-user local-runner catalog, but for the
// OpenRouter gateway. OpenRouter is a single OpenAI-compatible endpoint to 300+
// models reached via the workspace's API-key pool; rather than a hardcoded handful,
// a workspace BROWSES the live catalog (`refresh`) and ENABLES a subset (`upsert`).
// The persisted subset carries each model's context window + per-1M price, so the
// picker and the spend budget have them without a live fetch.
//
// `refresh` leases the workspace's OpenRouter key from the shared API-key pool and
// probes OpenRouter's `/models` server-side; it never throws (failures surface as
// `{ reachable: false, error }`). The fetched prices are USD per token; they are
// converted to the spend currency here (default EUR, matching the built-in pricing
// table) so the persisted metadata is directly usable by the spend overlay.

/** Default OpenRouter gateway base URL (overridable per deployment via env). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** The gateway provider id this service manages in the shared catalog table. */
const PROVIDER = 'openrouter'

/** Approximate USD→EUR rate, matching the built-in EUR spend table's assumption. */
const DEFAULT_USD_TO_CURRENCY = 0.92

export interface OpenRouterCatalogServiceDependencies {
  /** Generic per-workspace gateway-catalog store (shared with other gateways). */
  providerModelCatalogRepository: ProviderModelCatalogRepository
  /** Shared API-key pool, used to lease the workspace's OpenRouter key for `refresh`. */
  apiKeys: ApiKeyService
  clock: Clock
  /** OpenRouter base URL; defaults to {@link OPENROUTER_BASE_URL}. */
  baseUrl?: string
  /** USD→spend-currency conversion for fetched prices; defaults to ~0.92 (EUR). */
  usdToCurrencyRate?: number
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

export class OpenRouterCatalogService {
  constructor(private readonly deps: OpenRouterCatalogServiceDependencies) {}

  /** The workspace's enabled-catalog record (empty when none configured yet). */
  async get(workspaceId: string): Promise<OpenRouterCatalog> {
    const record = await this.deps.providerModelCatalogRepository.getByWorkspace(
      workspaceId,
      PROVIDER,
    )
    if (!record) {
      const now = this.deps.clock.now()
      return { models: [], createdAt: now, updatedAt: now }
    }
    return { models: record.models, createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  /** Replace the workspace's enabled OpenRouter models with the supplied subset. */
  async upsert(
    workspaceId: string,
    input: UpsertOpenRouterCatalogInput,
  ): Promise<OpenRouterCatalog> {
    const now = this.deps.clock.now()
    const existing = await this.deps.providerModelCatalogRepository.getByWorkspace(
      workspaceId,
      PROVIDER,
    )
    const record: ProviderModelCatalogRecord = {
      workspaceId,
      provider: PROVIDER,
      models: dedupe(input.models),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.providerModelCatalogRepository.upsert(record)
    return { models: record.models, createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  /** Remove the workspace's enabled catalog. */
  async remove(workspaceId: string): Promise<void> {
    await this.deps.providerModelCatalogRepository.remove(workspaceId, PROVIDER)
  }

  /**
   * The workspace's enabled OpenRouter models — the input to the per-workspace catalog
   * (`openRouterSelectableModels`) and the spend price overlay (`withDynamicPrices`).
   */
  async capabilitiesFor(workspaceId: string): Promise<OpenRouterModelMeta[]> {
    const record = await this.deps.providerModelCatalogRepository.getByWorkspace(
      workspaceId,
      PROVIDER,
    )
    return record?.models ?? []
  }

  /**
   * Probe OpenRouter's live `/models` for the browse list, leasing the workspace's pooled
   * OpenRouter key. Never throws — failures (no key, network, non-OK) surface as
   * `{ reachable: false, error }` so the UI can show them.
   */
  async refresh(
    workspaceId: string,
    opts?: { userId?: string | null },
  ): Promise<OpenRouterRefreshResult> {
    let secret: string
    try {
      const leased = await this.deps.apiKeys.lease(workspaceId, 'openrouter', {
        userId: opts?.userId ?? null,
      })
      secret = leased.secret
    } catch (err) {
      return { reachable: false, models: [], error: getErrorMessage(err) }
    }
    const doFetch = this.deps.fetch ?? fetch
    const base = (this.deps.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')
    const rate = this.deps.usdToCurrencyRate ?? DEFAULT_USD_TO_CURRENCY
    try {
      const res = await doFetch(`${base}/models`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        return { reachable: false, models: [], error: `OpenRouter returned HTTP ${res.status}` }
      }
      const body = (await res.json()) as { data?: unknown }
      const models = parseModels(body.data, rate)
      return { reachable: true, models }
    } catch (err) {
      return { reachable: false, models: [], error: getErrorMessage(err) }
    }
  }
}

interface RawModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
}

/** Map OpenRouter's `/models` payload to our metadata, converting USD/token → currency/1M. */
function parseModels(data: unknown, rate: number): OpenRouterModelMeta[] {
  if (!Array.isArray(data)) return []
  const out: OpenRouterModelMeta[] = []
  for (const raw of data as RawModel[]) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (!id) continue
    const prompt = perMillion(raw?.pricing?.prompt, rate)
    const completion = perMillion(raw?.pricing?.completion, rate)
    const contextLength = typeof raw?.context_length === 'number' ? raw.context_length : undefined
    out.push({
      id,
      name: typeof raw?.name === 'string' ? raw.name : id,
      ...(contextLength ? { contextLength } : {}),
      inputPerMillion: prompt,
      outputPerMillion: completion,
    })
  }
  return out
}

/** USD-per-token (a string or number) → currency-per-1M-token, rounded to 4 dp. */
function perMillion(usdPerToken: unknown, rate: number): number {
  const n = typeof usdPerToken === 'number' ? usdPerToken : Number(usdPerToken)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 1_000_000 * rate * 10_000) / 10_000
}

function dedupe(models: OpenRouterModelMeta[]): OpenRouterModelMeta[] {
  const seen = new Map<string, OpenRouterModelMeta>()
  for (const m of models) {
    const id = m.id.trim()
    if (id) seen.set(id, { ...m, id })
  }
  return [...seen.values()]
}

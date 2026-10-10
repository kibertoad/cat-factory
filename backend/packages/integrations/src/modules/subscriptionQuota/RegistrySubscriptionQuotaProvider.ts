import type {
  Clock,
  IdGenerator,
  SubscriptionQuotaCycle,
  SubscriptionQuotaCycleRepository,
  SubscriptionQuotaProvider,
  SubscriptionQuotaTarget,
  SubscriptionQuotaWindow,
  SubscriptionQuotaWindowKind,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { SUBSCRIPTION_QUOTA_WINDOWS, subscriptionQuotaCeiling } from '@cat-factory/kernel'

/**
 * A single subscription vendor's REAL quota read, built from the credentials the harness
 * or a side channel exposes. The composite owns everything vendor-neutral (persistence,
 * the modeled fallback, the reduction); an adapter just returns the vendor's real windows
 * (used %, reset) when it can. Registered per vendor. Empty today — the real Claude/GLM
 * reads land in Part B2 (an executor-harness image bump), so every vendor currently
 * degrades to the modeled window.
 */
export interface SubscriptionQuotaAdapter {
  /**
   * The vendor's real quota windows for a target, or `null` when unavailable (endpoint
   * down, credential absent, vendor exposes nothing). A `null` degrades to the modeled
   * window — an undocumented/best-effort read must never fail a caller.
   */
  readWindows(target: SubscriptionQuotaTarget): Promise<SubscriptionQuotaWindow[] | null>
}

/** The set of vendors a facade can read real quota numbers for. */
export type SubscriptionQuotaRegistry = Partial<
  Record<SubscriptionVendor, SubscriptionQuotaAdapter>
>

/** Optional per-(vendor, window) modeled ceiling overrides (else the kernel defaults). */
export type SubscriptionQuotaCeilingOverrides = Partial<
  Record<SubscriptionVendor, Partial<Record<SubscriptionQuotaWindowKind, number | null>>>
>

export interface RegistrySubscriptionQuotaProviderDependencies {
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
  idGenerator: IdGenerator
  clock: Clock
  /** The vendors this facade can read real quota numbers for. Empty ⇒ all modeled. */
  registry?: SubscriptionQuotaRegistry
  /** Override the modeled per-vendor ceilings (config-driven); else the kernel defaults. */
  ceilings?: SubscriptionQuotaCeilingOverrides
}

/**
 * The pluggable `SubscriptionQuotaProvider`, mirroring `RegistryReleaseHealthProvider`:
 * `recordUsage` folds a finished run's tokens into the persisted rolling-window counters
 * (one per window kind, anchored at first use); `report` returns the cycle from a real
 * vendor adapter when one is registered and answers, else the MODELED window (the
 * persisted counters measured against the config ceilings). A vendor with no adapter
 * always reports modeled — it never fails.
 */
export class RegistrySubscriptionQuotaProvider implements SubscriptionQuotaProvider {
  constructor(private readonly deps: RegistrySubscriptionQuotaProviderDependencies) {}

  async recordUsage(
    target: SubscriptionQuotaTarget,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const at = this.deps.clock.now()
    // Fold the run into every modeled window (5h + weekly). Each is a separate row so it
    // resets on its own cadence; the repo UPSERT anchors the window at first use.
    for (const window of SUBSCRIPTION_QUOTA_WINDOWS) {
      await this.deps.subscriptionQuotaCycleRepository.recordUsage(
        {
          id: this.deps.idGenerator.next('subq'),
          scope: target.scope,
          scopeId: target.scopeId,
          vendor: target.vendor,
          windowKind: window.kind,
        },
        usage,
        at,
        window.ms,
      )
    }
  }

  async report(target: SubscriptionQuotaTarget): Promise<SubscriptionQuotaCycle> {
    // A registered adapter's real read supersedes the model for that vendor. Best-effort:
    // a throwing/absent adapter degrades to the modeled window rather than failing.
    const adapter = this.deps.registry?.[target.vendor]
    if (adapter) {
      try {
        const real = await adapter.readWindows(target)
        if (real && real.length > 0) {
          return { ...target, windows: real, source: 'real' }
        }
      } catch {
        // Undocumented/best-effort read failed — fall through to the modeled window.
      }
    }
    return { ...target, windows: await this.modeledWindows(target), source: 'modeled' }
  }

  /** Build the modeled windows from the persisted counters + config ceilings. */
  private async modeledWindows(
    target: SubscriptionQuotaTarget,
  ): Promise<SubscriptionQuotaWindow[]> {
    const rows = await this.deps.subscriptionQuotaCycleRepository.listByScopeVendor(
      target.scope,
      target.scopeId,
      target.vendor,
    )
    const byKind = new Map(rows.map((r) => [r.windowKind, r]))
    const now = this.deps.clock.now()
    return SUBSCRIPTION_QUOTA_WINDOWS.map(({ kind, ms }) => {
      const row = byKind.get(kind)
      const limitTokens = subscriptionQuotaCeiling(target.vendor, kind, this.deps.ceilings)
      // A window whose anchor has aged out has effectively reset — report it as empty.
      const active = row && now - row.windowStartedAt < ms
      const usedTokens = active ? row.inputTokens + row.outputTokens : 0
      const windowStartedAt = active ? row.windowStartedAt : null
      const resetsAt = windowStartedAt === null ? null : windowStartedAt + ms
      const usedPercent =
        limitTokens && limitTokens > 0 ? Math.min(1, usedTokens / limitTokens) : null
      return {
        kind,
        usedTokens,
        limitTokens,
        usedPercent,
        windowStartedAt,
        resetsAt,
        source: 'modeled',
      }
    })
  }
}

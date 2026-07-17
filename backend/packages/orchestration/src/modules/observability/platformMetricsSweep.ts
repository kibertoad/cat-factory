import type { PlatformObservability, PlatformObservabilityWindow } from '@cat-factory/contracts'

// Runtime-neutral sweep that publishes the deployment-level (platform-operator)
// observability aggregates to an external metrics sink (today the OpenTelemetry OTLP
// exporter). It is the platform analogue of the per-run LLM trace sink: a periodic push of
// "how is the WHOLE deployment doing" so an operator can watch run success/failure rates,
// live/parked depth, failure taxonomy and duration percentiles in their own metrics backend.
//
// Driven from the Cloudflare `scheduled` cron and the Node interval timer (kept symmetric,
// like the retention + artifact sweeps). The per-runtime wiring supplies the account list +
// the per-account summarize as closures, so this driver stays free of any repo/runtime types
// and is trivially unit-testable — mirroring `sweepBinaryArtifactRetention`.
//
// The projection is inherently ONE aggregate report per account (each `summarize` is five
// GROUP BY queries run in parallel), computed per tenant on a low-frequency timer — the same
// "enumerate tenants, act per tenant in a sweeper" shape the artifact-retention sweep uses,
// NOT the banned per-row point-read N+1. Errors are per-account best-effort: a failure to
// summarize or export one account is logged and skipped, never aborting the others.

/**
 * The distinct, non-null account ids owning the given workspaces — the account list the
 * sweep exports, derived from the workspace projection the same way the artifact-retention
 * sweep enumerates workspaces (via `listVisible(null)`). Legacy unscoped boards
 * (`accountId === null`) are skipped: the platform-metrics port is account-scoped, so a
 * null-account workspace's runs belong to no account query. Order is stable (first seen).
 */
export function distinctAccountIds(workspaces: { accountId: string | null }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ws of workspaces) {
    if (ws.accountId && !seen.has(ws.accountId)) {
      seen.add(ws.accountId)
      out.push(ws.accountId)
    }
  }
  return out
}

/** The external sink a platform-observability snapshot is pushed to (the OTLP exporter). */
export interface PlatformMetricsSink {
  export(snapshot: PlatformObservability, dims: { accountId: string }): Promise<void>
}

/** Minimal structured logger (pino-compatible); optional. */
export interface PlatformMetricsSweepLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

export interface PlatformMetricsSweepDeps {
  /** The accounts to export, resolved once per sweep (deduplicated by the caller). */
  listAccountIds: () => Promise<string[]>
  /** Compute one account's platform-observability projection over {@link window}. */
  summarize: (
    accountId: string,
    window: PlatformObservabilityWindow,
  ) => Promise<PlatformObservability>
  /** Where the snapshots are pushed (the OTLP platform-metrics exporter). */
  sink: PlatformMetricsSink
  /** The trailing window each snapshot aggregates over. */
  window: PlatformObservabilityWindow
  logger?: PlatformMetricsSweepLogger
}

/**
 * Export the platform-observability aggregates for every account to the sink. Returns the
 * number of accounts successfully exported. Best-effort per account (see the file header);
 * the sweep as a whole resolves even if every account fails.
 */
export async function sweepPlatformMetrics(deps: PlatformMetricsSweepDeps): Promise<number> {
  let accountIds: string[]
  try {
    accountIds = await deps.listAccountIds()
  } catch (err) {
    deps.logger?.warn(
      { scope: 'platform-metrics', err: err instanceof Error ? err.message : String(err) },
      'platform-metrics: failed to list accounts',
    )
    return 0
  }

  let exported = 0
  for (const accountId of accountIds) {
    try {
      const snapshot = await deps.summarize(accountId, deps.window)
      await deps.sink.export(snapshot, { accountId })
      exported += 1
    } catch (err) {
      deps.logger?.warn(
        {
          scope: 'platform-metrics',
          accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        'platform-metrics: failed to export account',
      )
    }
  }
  return exported
}

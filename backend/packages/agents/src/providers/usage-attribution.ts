import { isUsageBilling, type AgentRunResult, type UsageBilling } from '@cat-factory/kernel'

// How a RESOLVED model states the credential it was built on, so the spend ledger records the
// billing kind wherever the call was made from.
//
// The container executor could answer this at its dispatch site, because it resolves the
// subscription credential itself. The inline path cannot: `AiAgentExecutor` asks a
// `ModelProvider` for a model and never learns which credential served it, so every inline
// step defaulted to `'metered'` with no vendor — including the kinds that ran on the very same
// subscription the containerised steps were correctly tagged with (a run's `architect` filed
// as subscription while its `architect-companion`, one credential and one process apart, filed
// as metered spend that no card was ever charged for).
//
// So the answer travels ON THE MODEL, from the provider that resolved the credential to the
// executor that reports the usage, exactly like `reportsOwnLlmCalls` travels from the same
// place to the instrumentation middleware. A model that says nothing is metered, which is what
// a direct provider key is.

/** The billing attribution of one resolved model: what pays for its calls, and to whom. */
export interface UsageAttribution {
  billing: UsageBilling
  /**
   * The vendor the credential belongs to, as the model ref's PROVIDER slug (`anthropic`,
   * `openai`), which is what the container path records for the same run. Never empty: a
   * subscription row whose vendor is blank cannot be grouped or reconciled against anything.
   */
  vendor: string
}

/**
 * A `LanguageModelV3` that knows how its calls are billed because it was built on the
 * credential that serves them.
 *
 * Declared as a marker the EXECUTOR reads rather than a flag a facade sets, for the same reason
 * `SelfReportingLanguageModel` is: the credential is resolved deep inside a per-scope
 * provider chain, and the executor that reports the usage holds only the model that came back.
 */
export interface UsageAttributedLanguageModel {
  readonly usageAttribution: UsageAttribution
}

/**
 * The billing attribution `model` declares, or `undefined` when it declares none (a plain
 * metered provider key, whose calls are billed per token by the vendor's API).
 *
 * Takes `unknown` because that is what a reader has: the AI SDK's `LanguageModel` union says
 * nothing about markers, and a provider package this repo does not own may put anything on the
 * property. So the shape is CHECKED rather than trusted, and anything that is not a whole,
 * usable declaration degrades to "declares none" instead of throwing into the step that was
 * only trying to report its tokens. Two ways to be half a declaration, both treated as none:
 *
 * - a blank or absent vendor, because the pair only means anything together and a subscription
 *   row with no vendor is exactly the row the usage report could not group;
 * - a `billing` outside the closed vocabulary, which no reader downstream could act on.
 *
 * The vendor comes back TRIMMED, so the ledger stores the value the usage report groups by
 * rather than one that only looks like it.
 */
export function usageAttributionOf(model: unknown): UsageAttribution | undefined {
  const declared: unknown = (model as { usageAttribution?: unknown } | null | undefined)
    ?.usageAttribution
  if (typeof declared !== 'object' || declared === null) return undefined
  const { billing, vendor } = declared as { billing?: unknown; vendor?: unknown }
  if (!isUsageBilling(billing)) return undefined
  const trimmed = typeof vendor === 'string' ? vendor.trim() : ''
  if (!trimmed) return undefined
  return { billing, vendor: trimmed }
}

/**
 * The attribution a set of models AGREE on, or `undefined` when they do not.
 *
 * For a step whose tokens are the sum of several models' calls: a consensus panel, whose
 * participants and synthesizer are resolved separately and may sit on different credentials.
 * The ledger records ONE row per step, so the step has an attribution only when every model
 * behind it names the same one; a panel mixing a subscription participant with a metered one
 * genuinely spent money, and the ledger's `'metered'` default is what keeps that money visible
 * to the budget gate. Reporting the subscription half would hide a real cost, which is the more
 * dangerous of the two errors.
 *
 * Empty in ⇒ `undefined` out: nothing to agree about is not agreement.
 */
export function agreedUsageAttribution(models: readonly unknown[]): UsageAttribution | undefined {
  const first = models.length > 0 ? usageAttributionOf(models[0]) : undefined
  if (!first) return undefined
  const agrees = models.every((model) => {
    const attribution = usageAttributionOf(model)
    return attribution?.billing === first.billing && attribution.vendor === first.vendor
  })
  return agrees ? first : undefined
}

/**
 * The billing fields an {@link AgentRunResult} carries for the tokens `models` spent.
 *
 * The ONE reduction both inline executors use, so a single-actor step and a panel cannot end up
 * answering the same question differently: the single-actor path passes the one model it was
 * handed, the consensus path every model behind the sum it reports.
 *
 * Empty for models that declare nothing, which leaves the result exactly as it was: the spend
 * ledger's own default is `'metered'` with no vendor, and a plain provider API key is precisely
 * that. A declared attribution always carries both halves, so a subscription row can never reach
 * the ledger with the blank vendor that made the mis-filed rows unrecognisable.
 */
export function usageBillingFields(
  models: readonly unknown[],
): Pick<AgentRunResult, 'usageBilling' | 'usageVendor'> {
  const attribution = agreedUsageAttribution(models)
  if (!attribution) return {}
  return { usageBilling: attribution.billing, usageVendor: attribution.vendor }
}

import type { HarnessKind, ModelRef, SubscriptionVendor } from '@cat-factory/kernel'
import {
  CredentialRequiredError,
  SUBSCRIPTION_VENDORS,
  isIndividualVendor,
} from '@cat-factory/kernel'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'

// ---------------------------------------------------------------------------
// The per-job AUTH a container dispatch carries: a short-lived, model-locked LLM-proxy session
// token for the Pi harness, or a subscription credential for Claude Code / Codex, or the flag that
// says the harness drives the developer's own logged-in CLI.
//
// Its own module because it is now asked by more than one dispatcher. `ContainerAgentExecutor`
// asks it per pipeline step; the AGENT DRY RUN's prober asks it for the one job a self-test
// dispatches. A second implementation of this would be a second set of ways to hand a raw
// long-lived vendor credential to the wrong place, and the failure it would produce is quiet: a
// flow that only knows the Pi branch runs every model through the proxy, so a workspace whose
// preset says Claude gets a dispatch pinned to whatever the deployment's env routing happened to
// name: a model nobody chose, with no key configured for it, discovered as a `502` from the proxy
// after the run has already provisioned an environment.
// ---------------------------------------------------------------------------

/** A subscription token leased from the workspace's pool for a vendor. */
export interface LeasedSubscriptionToken {
  tokenId: string
  secret: string
}

/** Lease the least-loaded subscription token for a vendor, or throw if none. */
export type LeaseSubscriptionToken = (
  workspaceId: string,
  vendor: SubscriptionVendor,
) => Promise<LeasedSubscriptionToken>

/**
 * Lease the run-initiator's OWN activated personal credential for an individual-usage
 * vendor (Claude). Scoped to the run + user (not pooled); throws a
 * `CredentialRequiredError` when the run has no live activation (the user must re-enter
 * their password). Returns just the raw secret and no token id, since there is no pool
 * rotation/usage to attribute for a single-user credential.
 */
export type LeasePersonalSubscriptionToken = (
  executionId: string,
  userId: string,
  vendor: SubscriptionVendor,
) => Promise<{ secret: string }>

export interface ContainerJobAuthDependencies {
  /** Mints the signed LLM-proxy session token the container uses (Pi harness). */
  sessionService: ContainerSessionService
  /**
   * Public base URL of the facade's OpenAI-compatible LLM proxy, including the
   * `/v1` suffix: Pi posts to `${proxyBaseUrl}/chat/completions`.
   */
  proxyBaseUrl: string
  /**
   * Resolve a workspace's owning account id, signed into the proxy session token so the
   * proxy can lease an account-scoped API key from the merged pool. Optional; absent ⇒
   * only the workspace + initiator scopes are leased.
   */
  resolveAccountId?: (workspaceId: string) => Promise<string | null | undefined>
  /**
   * Lease a pooled subscription token for a vendor. Required for the Claude Code /
   * Codex subscription harnesses; absent ⇒ those harnesses are unavailable and a
   * subscription-only model fails loudly at dispatch.
   */
  leaseSubscriptionToken?: LeaseSubscriptionToken
  /**
   * Lease the run-initiator's personal (individual-usage) credential for a vendor like
   * Claude. Required to run an individual-usage model; absent ⇒ such models fail loudly
   * at dispatch (the per-user personal store isn't wired on this deployment).
   */
  leasePersonalSubscriptionToken?: LeasePersonalSubscriptionToken
  /**
   * Whether the WORKSPACE holds a pooled token for a vendor, and whether the USER holds their own
   * personal one. Optional; absent ⇒ {@link ContainerJobAuthResolver.describeAuthGap} reports no
   * gap it cannot see, and the lease itself is still the authority.
   *
   * They sit here as well as on the model router because they answer the same question at two
   * moments, and only this module can turn the answer into a REFUSAL: the router asks "should a
   * dual-mode model switch to its subscription flavour?", the gap check asks "is there a credential
   * to open the harness this model already names?". A subscription-ONLY model (Codex) carries its
   * harness whatever the pool holds, so nothing in the routing can notice the missing token: it
   * surfaces as a throw from the lease, which on a dry run costs a branch, a provision and a
   * teardown to reach.
   */
  hasSubscriptionToken?: (workspaceId: string, vendor: SubscriptionVendor) => Promise<boolean>
  hasPersonalSubscription?: (userId: string, vendor: SubscriptionVendor) => Promise<boolean>
  /**
   * NATIVE LOCAL EXECUTION (local facade only, opt-in via `LOCAL_NATIVE_AGENTS`): when this
   * returns true for a resolved subscription harness + vendor, the job carries
   * `ambientAuth: true` INSTEAD of a leased credential. The harness (run as a host process)
   * drives the developer's OWN installed `claude` / `codex` CLI with its ambient login. No
   * token is leased and no personal-credential gate applies. It is passed the resolved
   * `vendor` precisely so it can refuse a non-native vendor that merely REUSES the
   * `claude-code` harness (GLM/Kimi/DeepSeek): those carry an Anthropic-compatible
   * `subscriptionBaseUrl`, which ambient auth would silently drop, running the step on the
   * developer's own Anthropic login instead of the pinned vendor. Default off everywhere
   * else, so the Cloudflare/Node leasing paths are untouched.
   */
  nativeAmbientAuth?: (harness: HarnessKind, vendor: SubscriptionVendor | undefined) => boolean
}

/**
 * WHICH credential channel a dispatch needs: the harness the resolved model names, the vendor
 * behind it, and whose it would be.
 *
 * Split out of {@link ContainerJobAuthRequest} because {@link
 * ContainerJobAuthResolver.describeAuthGap} answers from exactly this much and no more. Asking it
 * for a whole request would have an admission check invent an `executionId` for a run that does not
 * exist yet, and a fabricated id is a thing later code reads as one.
 */
export interface ContainerJobAuthSubject {
  harness: HarnessKind
  subscriptionVendor: SubscriptionVendor | undefined
  workspaceId: string
  /**
   * Whoever started the work. An individual-usage credential belongs to one person, so its lease
   * cannot be resolved without one.
   */
  initiatedByUserId?: string | null
}

/** One dispatch's identity, as the auth channels need it. */
export interface ContainerJobAuthRequest extends ContainerJobAuthSubject {
  ref: ModelRef
  /**
   * The correlation id the container's model calls are metered under. A pipeline step passes its
   * run id; a single-job flow passes the id of the row that IS its run, which is also the id its
   * personal-credential activation was minted against.
   */
  executionId: string
  /** The kind the spend is filed under, signed into the proxy session token. */
  agentKind: string
}

/** What a dispatch spreads into its job body, plus the pooled token id it must attribute back. */
export interface ContainerJobAuth {
  auth: Record<string, unknown>
  subscriptionTokenId?: string
}

/**
 * Resolve the per-job auth the harness carries: the proxy session token for Pi, or a
 * leased subscription token for Claude Code / Codex. Spread into every job body so the
 * per-kind bodies (and the single-job flows) can't drift on which auth they forward.
 */
export class ContainerJobAuthResolver {
  constructor(private readonly deps: ContainerJobAuthDependencies) {}

  /**
   * Why this dispatch's credential could not be resolved, or `null` when it can be, WITHOUT
   * leasing anything.
   *
   * For a flow that can be refused before it spends: the environment dry run asks it at admission,
   * where "this deployment has no Codex subscription connected" is a sentence an operator can act
   * on, rather than at the dispatch, where the same fact arrives as a failed run with a branch and
   * a provisioned environment behind it.
   *
   * It lives beside {@link resolve} rather than in the caller so the two cannot disagree: every
   * refusal below is one `resolve` would have thrown, in the same words. It is deliberately NOT a
   * guarantee (a token can be revoked between the check and the lease, and a personal activation
   * is minted after it), so the lease stays the authority and this is only the cheap early no.
   */
  async describeAuthGap(subject: ContainerJobAuthSubject): Promise<string | null> {
    const { harness, subscriptionVendor, workspaceId } = subject
    // The Pi harness mints its own proxy session token, so there is nothing to be short of.
    if (harness === 'pi') return null
    if (this.deps.nativeAmbientAuth?.(harness, subscriptionVendor)) return null
    if (!subscriptionVendor) return this.harnessUnconfigured(harness)
    if (isIndividualVendor(subscriptionVendor)) {
      if (!this.deps.leasePersonalSubscriptionToken) {
        return this.personalStoreUnconfigured(subscriptionVendor)
      }
      const userId = subject.initiatedByUserId ?? undefined
      if (!userId) return this.noIdentifiedInitiator(subscriptionVendor)
      // The password-backed ACTIVATION is minted per run and cannot exist yet; what is checkable
      // now is whether this person has the subscription at all.
      if (
        this.deps.hasPersonalSubscription &&
        !(await this.deps.hasPersonalSubscription(userId, subscriptionVendor))
      ) {
        return (
          `Running a ${subscriptionVendor} model needs your own personal ${subscriptionVendor} ` +
          `subscription, and none is connected to your account.`
        )
      }
      return null
    }
    if (!this.deps.leaseSubscriptionToken) return this.harnessUnconfigured(harness)
    if (
      this.deps.hasSubscriptionToken &&
      !(await this.deps.hasSubscriptionToken(workspaceId, subscriptionVendor))
    ) {
      return (
        `This model runs on a ${subscriptionVendor} subscription, and this workspace has no ` +
        `${subscriptionVendor} subscription token connected. Connect one, or pick a different model.`
      )
    }
    return null
  }

  /**
   * The three refusals {@link describeAuthGap} and {@link resolve} share, worded ONCE.
   *
   * Shared because the whole value of the gap check is that admission refuses for the reason the
   * dispatch would have: two spellings of "no Codex subscription connected" is how an operator
   * comes to fix the thing the earlier message named and hit the later one.
   */
  private harnessUnconfigured(harness: HarnessKind): string {
    return (
      `The ${harness} harness is not configured on this deployment; connect a ` +
      `subscription token or pick a different model.`
    )
  }

  private personalStoreUnconfigured(vendor: SubscriptionVendor): string {
    return (
      `Personal ${vendor} subscriptions are not configured on this ` +
      `deployment (no ENCRYPTION_KEY); pick a different model.`
    )
  }

  private noIdentifiedInitiator(vendor: SubscriptionVendor): string {
    return `Running a ${vendor} model requires a signed-in user with a personal subscription.`
  }

  async resolve(request: ContainerJobAuthRequest): Promise<ContainerJobAuth> {
    const { harness, ref, subscriptionVendor, workspaceId, executionId, agentKind } = request
    const initiatedByUserId = request.initiatedByUserId ?? undefined
    if (harness === 'pi') {
      const accountId = this.deps.resolveAccountId
        ? await this.deps.resolveAccountId(workspaceId)
        : undefined
      const sessionToken = await this.deps.sessionService.mint({
        workspaceId,
        accountId: accountId ?? undefined,
        userId: initiatedByUserId,
        executionId,
        agentKind,
        provider: ref.provider,
        model: ref.model,
      })
      // `proxyPhasePath` states what THIS backend serves: the phase-tagged completions route
      // the harness tags Pi's base URL with, so each call is attributed to the run phase that
      // spent it (`docs/initiatives/token-burn-instrumentation.md`). Unconditional: the route
      // is part of `llmProxyController`, so any backend running this code has it. It is the
      // harness that may be older or newer, and telling it what we serve is what keeps an
      // image pinned by a runner pool (or `LOCAL_HARNESS_IMAGE`) from posting every model call
      // to a 404. Same shape as `webSearch` on the step path: the backend declares, the harness
      // points.
      return {
        auth: {
          harness,
          proxyBaseUrl: this.deps.proxyBaseUrl,
          proxyPhasePath: true,
          sessionToken,
        },
      }
    }
    // Native local execution: the harness runs the developer's own CLI with its ambient
    // login, so we lease NOTHING and gate NOTHING, and only flag ambient auth for the harness.
    // Passed the vendor so it can refuse a non-native vendor reusing the `claude-code`
    // harness (GLM/Kimi/DeepSeek), whose subscriptionBaseUrl ambient auth would drop.
    if (this.deps.nativeAmbientAuth?.(harness, subscriptionVendor)) {
      return { auth: { harness, ambientAuth: true } }
    }
    if (!subscriptionVendor) throw new Error(this.harnessUnconfigured(harness))
    // Individual-usage vendors (Claude) are NOT pooled: lease the run-initiator's OWN
    // activated personal credential. Pooled vendors (GLM/Kimi/DeepSeek/Codex) lease
    // from the workspace pool. Either path hands the RAW credential to the resolved
    // runner transport (see the trust note below).
    let secret: string
    let subscriptionTokenId: string | undefined
    if (isIndividualVendor(subscriptionVendor)) {
      if (!this.deps.leasePersonalSubscriptionToken) {
        throw new Error(this.personalStoreUnconfigured(subscriptionVendor))
      }
      if (!initiatedByUserId) {
        // No identified initiator (auth-disabled/local dev): an individual-usage
        // credential is owned by a specific user and can't be resolved without one.
        throw new CredentialRequiredError(this.noIdentifiedInitiator(subscriptionVendor), {
          vendor: subscriptionVendor,
          reason: 'no_subscription',
        })
      }
      // Throws CredentialRequiredError(password_required) when the run has no live
      // activation: the dispatch path surfaces it as a clear, retriable failure.
      const leased = await this.deps.leasePersonalSubscriptionToken(
        executionId,
        initiatedByUserId,
        subscriptionVendor,
      )
      secret = leased.secret
    } else {
      if (!this.deps.leaseSubscriptionToken) throw new Error(this.harnessUnconfigured(harness))
      const leased = await this.deps.leaseSubscriptionToken(workspaceId, subscriptionVendor)
      subscriptionTokenId = leased.tokenId
      secret = leased.secret
    }
    // SECURITY/TRUST: unlike the Pi harness (short-lived, model-locked proxy session
    // token) this hands the RAW, long-lived subscription credential (a Claude OAuth
    // token or a full ChatGPT auth.json) to the resolved runner transport. For the
    // Cloudflare backend that is an ephemeral, managed per-run container. For a
    // self-hosted runner pool it is the WORKSPACE'S OWN BYO infra (it connected the
    // pool), so the credential stays within the workspace's trust domain, but a
    // workspace should only point its subscription-harness steps at a runner pool it
    // operates, since the credential leaves the backend to reach it.
    // Non-Anthropic Claude-Code vendors (GLM/Kimi/DeepSeek) need their Anthropic-
    // compatible base URL; Anthropic itself uses the OAuth token against api.anthropic.com.
    const baseUrl = SUBSCRIPTION_VENDORS[subscriptionVendor].baseUrl
    return {
      auth: {
        harness,
        subscriptionToken: secret,
        ...(baseUrl ? { subscriptionBaseUrl: baseUrl } : {}),
      },
      ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
    }
  }
}

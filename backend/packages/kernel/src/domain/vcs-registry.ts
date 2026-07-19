import type { VcsConnectionRef, VcsProvider } from './vcs-types.js'
import type { VcsClient } from '../ports/vcs-client.js'
import type { VcsProvisioningClient } from '../ports/vcs-provisioning.js'
import type { WebhookVerifier } from '../ports/webhook-verifier.js'
import type { VcsWebhookMapper } from '../ports/vcs-webhook.js'

// ---------------------------------------------------------------------------
// An app-owned registry of VCS providers, keyed by the {@link VcsProvider}
// discriminator. It mirrors the gate / agent-kind / backend registries: the
// composition root news ONE instance ({@link defaultVcsRegistry}), threads it
// through `CoreDependencies`, and surfaces it on the `ServerContainer`, so the
// neutral webhook receiver + any caller holding a {@link VcsConnectionRef}
// resolves the concrete adapter bundle through that injected instance.
//
// This replaces the previous module-global `Map`. That module global was
// exactly the "brittle for externally-published adapter packages" hazard the
// registry-DI migration targets: `@cat-factory/gitlab` is a separate published
// package, so a deployment that bundled its own copy of `@cat-factory/kernel`
// would have registered into a phantom `Map` invisible to the server. With the
// instance owned by the facade and passed by reference, module identity stops
// mattering: an adapter registers on the instance it is handed
// (`registry.register(bundle)`), and tests build a fresh registry instead of
// calling a `clear*()`.
// ---------------------------------------------------------------------------

/**
 * The concrete per-provider differentiators the rest of the platform resolves through a
 * {@link VcsConnectionRef}. Each adapter package supplies one bundle. Members beyond
 * `client` are optional so a provider can be registered incrementally (e.g. a read-only
 * provider with no webhook ingest or no repo provisioning).
 */
export interface VcsProviderBundle {
  /** Which provider this bundle serves (matches the registry key). */
  readonly provider: VcsProvider
  /** The repo/PR/issue/CI client — the neutral slice of the provider's API. */
  readonly client: VcsClient
  /** Verifies inbound webhook signatures (GitHub HMAC / GitLab token), if supported. */
  readonly webhookVerifier?: WebhookVerifier
  /** Normalises a raw webhook delivery into a neutral {@link VcsWebhookEvent}, if supported. */
  readonly webhookMapper?: VcsWebhookMapper
  /** Privileged repo creation, if supported. */
  readonly provisioning?: VcsProvisioningClient
}

/**
 * App-owned registry of VCS provider bundles, keyed by the {@link VcsProvider} discriminator.
 * The composition root news ONE instance and threads it through the container; a deployment
 * (or an adapter package like `@cat-factory/gitlab`) registers each provider it supports on
 * that instance by reference, and any caller holding a {@link VcsConnectionRef} resolves the
 * concrete adapter through it. Mirrors {@link GateRegistry} / the backend registries — there
 * is no module-global `Map` and no `clear*()` test cruft.
 */
export class VcsProviderRegistry {
  private readonly registry = new Map<VcsProvider, VcsProviderBundle>()

  /**
   * Register a VCS provider bundle. A later registration of the same provider replaces the
   * earlier one (so a deployment can override a built-in adapter). Register at startup,
   * before serving.
   */
  register(bundle: VcsProviderBundle): void {
    this.registry.set(bundle.provider, bundle)
  }

  /** The registered bundle for a provider, or `undefined` when nothing is registered. */
  get(provider: VcsProvider): VcsProviderBundle | undefined {
    return this.registry.get(provider)
  }

  /** Whether a bundle is registered for a provider. */
  has(provider: VcsProvider): boolean {
    return this.registry.has(provider)
  }

  /**
   * The registered bundle for a provider, or throw. Use when a {@link VcsConnectionRef} in
   * hand means a provider MUST be wired (a connection can only exist for a registered
   * provider) — the throw then surfaces a wiring bug rather than failing deep in a call.
   */
  require(provider: VcsProvider): VcsProviderBundle {
    const bundle = this.registry.get(provider)
    if (!bundle) {
      throw new Error(`VCS provider "${provider}" is not registered.`)
    }
    return bundle
  }

  /** Convenience: resolve the bundle for a connection ref (throws if unregistered). */
  resolve(connection: VcsConnectionRef): VcsProviderBundle {
    return this.require(connection.provider)
  }

  /** Every registered provider discriminator (registration order). */
  providers(): VcsProvider[] {
    return [...this.registry.keys()]
  }
}

/**
 * A fresh, empty VCS provider registry. A facade news one, registers the providers its
 * configuration enables (e.g. `@cat-factory/gitlab`'s `registerGitLab(registry, …)`), and
 * threads the SAME instance through the container.
 */
export function defaultVcsRegistry(): VcsProviderRegistry {
  return new VcsProviderRegistry()
}

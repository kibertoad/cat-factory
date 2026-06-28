import type { VcsConnectionRef, VcsProvider } from './vcs-types.js'
import type { VcsClient } from '../ports/vcs-client.js'
import type { VcsProvisioningClient } from '../ports/vcs-provisioning.js'
import type { WebhookVerifier } from '../ports/webhook-verifier.js'
import type { VcsWebhookEvent, VcsWebhookMapper } from '../ports/vcs-webhook.js'

// ---------------------------------------------------------------------------
// A process-wide registry of VCS providers, keyed by the {@link VcsProvider}
// discriminator. It mirrors the gate / pipeline / agent-kind registries: a
// deployment registers each provider it supports as a startup import side effect
// (`@cat-factory/server` registers `github`; `@cat-factory/gitlab` registers
// `gitlab`), and any caller holding a {@link VcsConnectionRef} resolves the
// concrete adapter bundle via {@link resolveVcsProvider}.
//
// Living in kernel (alongside the other registries) keeps integrations / gates /
// server able to read it without depending on a concrete adapter package, and lets
// an adapter package register itself without depending on the heavy orchestration
// package — exactly the way `registerGate` / `registerPipeline` already work.
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

// Process-wide map, keyed by provider discriminator. Registration is a startup side
// effect, read whenever a caller resolves a provider from a connection ref.
const registry = new Map<VcsProvider, VcsProviderBundle>()

/**
 * Register a VCS provider bundle. A later registration of the same provider replaces the
 * earlier one (so a deployment can override a built-in adapter). Register at startup,
 * before serving.
 */
export function registerVcsProvider(bundle: VcsProviderBundle): void {
  registry.set(bundle.provider, bundle)
}

/** The registered bundle for a provider, or `undefined` when nothing is registered. */
export function getVcsProvider(provider: VcsProvider): VcsProviderBundle | undefined {
  return registry.get(provider)
}

/** Whether a bundle is registered for a provider. */
export function isVcsProviderRegistered(provider: VcsProvider): boolean {
  return registry.has(provider)
}

/**
 * The registered bundle for a provider, or throw. Use when a {@link VcsConnectionRef} in
 * hand means a provider MUST be wired (a connection can only exist for a registered
 * provider) — the throw then surfaces a wiring bug rather than failing deep in a call.
 */
export function requireVcsProvider(provider: VcsProvider): VcsProviderBundle {
  const bundle = registry.get(provider)
  if (!bundle) {
    throw new Error(`VCS provider "${provider}" is not registered.`)
  }
  return bundle
}

/** Convenience: resolve the bundle for a connection ref (throws if unregistered). */
export function resolveVcsProvider(connection: VcsConnectionRef): VcsProviderBundle {
  return requireVcsProvider(connection.provider)
}

/** Every registered provider discriminator (registration order). */
export function registeredVcsProviders(): VcsProvider[] {
  return [...registry.keys()]
}

/** Drop all registered providers. Intended for tests that exercise registration. */
export function clearVcsProviders(): void {
  registry.clear()
}

export type { VcsWebhookEvent }

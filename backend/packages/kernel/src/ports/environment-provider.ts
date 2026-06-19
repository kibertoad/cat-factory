import type {
  EnvironmentAccessHandle,
  EnvironmentManifest,
  EnvironmentStatus,
} from '../domain/types.js'

// Port for an ephemeral-environment provider: the thing that actually calls an
// org's self-rolled management API to provision/observe/destroy environments.
// The worker supplies a single generic `fetch`-based adapter that *interprets a
// manifest*, so one stateless instance serves every workspace. Credentials are
// passed per call (resolved from the workspace's decrypted secret bundle) so the
// core never holds raw secrets at rest — mirroring the Confluence client.

/** Resolve a manifest `secretRef.key` to its value, or undefined if unset. */
export type SecretResolver = (key: string) => string | undefined

/** Fields extracted from an earlier provision response, for status/teardown. */
export type ProvisionFields = Record<string, string>

export interface ProvisionEnvironmentRequest {
  manifest: EnvironmentManifest
  /** Provision inputs (`{{input.*}}` in templates). */
  inputs: Record<string, string>
  resolveSecret: SecretResolver
}

export interface EnvironmentStatusRequest {
  manifest: EnvironmentManifest
  externalId: string | null
  /** Fields captured at provision time (`{{provision.*}}` in templates). */
  provisionFields: ProvisionFields
  resolveSecret: SecretResolver
}

export interface EnvironmentTeardownRequest {
  manifest: EnvironmentManifest
  externalId: string | null
  provisionFields: ProvisionFields
  resolveSecret: SecretResolver
}

/** The provider's view of a provisioned environment (mapped from its response). */
export interface ProvisionedEnvironment {
  externalId: string | null
  url: string | null
  status: EnvironmentStatus
  expiresAt: number | null
  access: EnvironmentAccessHandle | null
  /** All fields the response mapping captured, for later status/teardown calls. */
  fields: ProvisionFields
}

export interface EnvironmentProvider {
  provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment>
  status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment>
  teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }>
}

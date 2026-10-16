// Infrastructure: the setup projection the snapshot carries, the deployment's execution and test
// environment backends, the local runner settings, a Kubernetes environment handler, a custom
// manifest type, the private package registries and the capability credentials. For the
// infrastructure window, the setup banner and checklist, the handler forms and the window's
// panels. The registries, the keys and the capabilities that want them are made up.
import type {
  CapabilityCredentialStatus,
  CustomManifestType,
  EnvironmentHandlerView,
  InfraSetup,
  InfrastructureCapabilities,
  LocalSettings,
  PackageRegistryEntryView,
} from '@cat-factory/contracts'

/**
 * A workspace on a remote Node deployment with work left: no environment provider yet, a runner
 * pool that is configured but did not answer the last probe, and storage set up. Goes on the
 * snapshot as `infraSetup`.
 */
export const infraSetupNeedsWork: InfraSetup = {
  ephemeralEnvironments: 'not_defined',
  agentExecutor: 'unreachable',
  binaryStorage: 'configured',
}

/** Every area set up, or not needed on this runtime. */
export const infraSetupDone: InfraSetup = {
  ephemeralEnvironments: 'configured',
  agentExecutor: 'not_applicable',
  binaryStorage: 'configured',
}

/** What a local deployment offers: Docker on the host, Compose or an environment provider. */
export function infrastructureCapabilities(
  overrides: Partial<InfrastructureCapabilities> = {},
): InfrastructureCapabilities {
  return {
    execution: { available: ['local-docker', 'runner-pool'], active: 'local-docker' },
    testEnv: {
      available: ['local-compose', 'environment-provider'],
      active: 'local-compose',
    },
    frontendPreview: { supported: true },
    modelPolicy: { supported: true },
    ...overrides,
  }
}

/** A warm pool of two containers, and the default checkout settings. */
export const localSettings: LocalSettings = {
  pool: { size: 2, minWarm: 1, max: 4, idleTtlMs: 600_000 },
  checkout: {
    workspaceRoot: '/workspace',
    cleanKeep: ['node_modules', '.venv', 'target', '.gradle', '.pnpm-store'],
  },
}

/**
 * A remote Kubernetes cluster registered as the workspace's Kubernetes handler. `providerId`,
 * `label` and `baseUrl` are what the Kubernetes backend derives from the config, and its token
 * is stored under `apiToken`.
 */
export const kubernetesHandler: EnvironmentHandlerView = {
  provisionType: 'kubernetes',
  manifestId: null,
  engine: 'remote-kubernetes',
  providerId: 'kubernetes',
  label: 'Acme staging cluster',
  baseUrl: 'https://k8s.staging.acme.dev:6443',
  connectedAt: Date.UTC(2026, 8, 25),
  secretKeys: ['apiToken'],
  acceptsManifestId: null,
  backendKind: 'kubernetes',
  config: {
    engine: 'remote-kubernetes',
    kubernetes: {
      label: 'Acme staging cluster',
      apiServerUrl: 'https://k8s.staging.acme.dev:6443',
      namespaceTemplate: 'auth-pr-{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: 'auth-pr-{{pullNumber}}.preview.acme.dev',
        scheme: 'https',
      },
    },
  },
}

/** A manifest type the deployment registered in code, so the workspace cannot edit it. */
export const registeredManifestType: CustomManifestType = {
  manifestId: 'terraform-stack',
  label: 'Terraform stack',
  source: 'registered',
  acceptsInputHint: 'A directory with a main.tf and a preview.tfvars',
  description: 'Applies the service Terraform into a throwaway workspace and reads the URL output.',
  defaultManifestPath: 'infra/preview',
}

/** A manifest type the workspace defined itself, which it can edit and delete. */
export const workspaceManifestType: CustomManifestType = {
  manifestId: 'fly-machine',
  label: 'Fly machine',
  source: 'workspace',
  description: 'Starts one Fly machine from the service image.',
  defaultManifestPath: 'fly.toml',
}

/** An npmjs entry and a GitHub Packages entry with two scopes. */
export const packageRegistryEntries: PackageRegistryEntryView[] = [
  { id: 'pr_npm_acme', ecosystem: 'npm', vendor: 'npmjs', scopes: ['@acme'], tokenTail: '4f2a' },
  {
    id: 'pr_ghp_acme',
    ecosystem: 'npm',
    vendor: 'github-packages',
    scopes: ['@acme-internal', '@acme-design'],
    tokenTail: 'Qx9e',
  },
]

function credential(
  overrides: Partial<CapabilityCredentialStatus> & Pick<CapabilityCredentialStatus, 'key'>,
): CapabilityCredentialStatus {
  return { declaredBy: [], required: true, stored: false, ...overrides }
}

/**
 * Three declared keys: one stored and wanted by two capabilities, one required and missing, and
 * one optional.
 */
export const declaredCapabilityCredentials: CapabilityCredentialStatus[] = [
  credential({
    key: 'ACME_TRACKER_TOKEN',
    stored: true,
    updatedAt: Date.UTC(2026, 9, 2),
    declaredBy: [
      { subject: 'tool-server', id: 'acme-tracker', label: 'Acme tracker' },
      {
        subject: 'foundational-service',
        id: 'issue-hub',
        label: 'Issue hub',
        usage: 'Read-only token for the issue search API.',
      },
    ],
  }),
  credential({
    key: 'SPRITE_RENDER_KEY',
    declaredBy: [{ subject: 'binary-generator', id: 'sprite-renderer', label: 'Sprite renderer' }],
  }),
  credential({
    key: 'AUDIT_LOG_TOKEN',
    required: false,
    declaredBy: [{ subject: 'foundational-service', id: 'audit-log', label: 'Audit log' }],
  }),
]

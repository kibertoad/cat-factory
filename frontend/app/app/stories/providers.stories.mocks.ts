// Model providers, the model catalog, infrastructure provider connections and spend, for the
// settings and setup stories. Each factory returns one realistic row; a story passes overrides for the variant it
// shows (an expired subscription, a blocked runner URL, an exceeded budget).
import type {
  ApiKey,
  ConnectionTestResult,
  EnvironmentConnection,
  LocalModelEndpoint,
  ModelOption,
  PersonalSubscriptionStatus,
  ProviderDescriptor,
  RunnerPoolConnection,
  SpendStatus,
  VendorCredential,
} from '@cat-factory/contracts'
import { orgAccount } from './accounts.stories.mocks'
import { STORY_WORKSPACE_ID } from './workspace'

/**
 * The ephemeral-environment provider, registered from a manifest. No `config`: the panels that
 * show a connection read its label, URL and secret names only.
 */
export const environmentConnection: EnvironmentConnection = {
  kind: 'manifest',
  providerId: 'acme-previews',
  label: 'Acme preview environments',
  baseUrl: 'https://previews.acme.dev/api',
  connectedAt: Date.UTC(2026, 8, 14),
  secretKeys: ['apiToken'],
}

/** The self-hosted runner pool, registered from a manifest. */
export const runnerPoolConnection: RunnerPoolConnection = {
  kind: 'manifest',
  providerId: 'acme-runners',
  label: 'Acme runner pool',
  baseUrl: 'https://runners.acme.dev',
  connectedAt: Date.UTC(2026, 8, 14),
  secretKeys: ['apiToken'],
}

/**
 * How a manifest provider describes itself: one secret API token, required. `missingRequired`
 * names what the workspace has not given it yet, which is what the setup banner reads.
 */
export function providerDescriptor(
  connection: { providerId: string; label: string },
  missingRequired: string[] = [],
): ProviderDescriptor {
  return {
    providerId: connection.providerId,
    label: connection.label,
    kind: 'manifest',
    configFields: [{ key: 'apiToken', label: 'API token', secret: true, required: true }],
    supportsTest: true,
    missingRequired,
  }
}

/** A connection test that connects but reports a gap, in the backend's own words. */
export const connectionTestWithWarnings: ConnectionTestResult = {
  ok: true,
  message: 'Connected to Acme runner pool.',
  warnings: [
    {
      code: 'runner_manifest_no_status_path',
      message:
        "Manifest 'acme-runners' maps no status path, so every poll reads as still running and a " +
        "job can only end by exhausting the run's poll budget.",
    },
  ],
}

/** Ollama on the user's own machine, with two models enabled. */
export function localModelEndpoint(
  overrides: Partial<LocalModelEndpoint> = {},
): LocalModelEndpoint {
  return {
    provider: 'ollama',
    label: 'Ollama on this laptop',
    baseUrl: 'http://localhost:11434',
    hasApiKey: false,
    models: [{ id: 'qwen3-coder:30b' }, { id: 'gemma3:27b', acceptsImages: true }],
    unreadableModels: false,
    urlBlockedReason: null,
    createdAt: Date.UTC(2026, 8, 20),
    updatedAt: Date.UTC(2026, 9, 2),
    ...overrides,
  }
}

/** The user's own Claude subscription, with an expiry two months out. */
export function personalSubscription(
  overrides: Partial<PersonalSubscriptionStatus> = {},
): PersonalSubscriptionStatus {
  return {
    vendor: 'claude',
    label: 'Claude Max',
    createdAt: Date.UTC(2026, 7, 3),
    updatedAt: Date.UTC(2026, 7, 3),
    lastUsedAt: Date.UTC(2026, 9, 11, 16, 20),
    expiresAt: Date.UTC(2026, 11, 3),
    expiresInDays: 52,
    expired: false,
    renewSoon: false,
    ...overrides,
  }
}

/** The workspace's OpenRouter key, enabled, used this morning. */
export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_openrouter_team',
    scope: 'workspace',
    scopeId: STORY_WORKSPACE_ID,
    provider: 'openrouter',
    label: 'Team OpenRouter',
    createdAt: Date.UTC(2026, 8, 2),
    lastUsedAt: Date.UTC(2026, 9, 12, 9, 15),
    inputTokens: 2_140_500,
    outputTokens: 388_210,
    requestCount: 642,
    enabled: true,
    isDefault: true,
    ...overrides,
  }
}

/** One token in the workspace's subscription pool, enabled and the default for its vendor. */
export function vendorCredential(overrides: Partial<VendorCredential> = {}): VendorCredential {
  return {
    id: 'vc_claude_team',
    vendor: 'claude',
    label: 'Team Claude Max',
    createdAt: Date.UTC(2026, 7, 10),
    lastUsedAt: Date.UTC(2026, 9, 11, 17, 5),
    inputTokens: 4_812_300,
    outputTokens: 912_450,
    requestCount: 1_384,
    enabled: true,
    isDefault: true,
    ...overrides,
  }
}

/** This month's spend, a little over a third of the budget. */
export function spendStatus(overrides: Partial<SpendStatus> = {}): SpendStatus {
  return {
    periodStart: Date.UTC(2026, 9, 1),
    inputTokens: 18_420_000,
    outputTokens: 2_910_000,
    costSpent: 182.4,
    costLimit: 500,
    currency: 'EUR',
    exceeded: false,
    ...overrides,
  }
}

/**
 * One model in the workspace catalog, as `listWorkspaceModelsContract` answers it: Kimi K2.7 on
 * Workers AI, usable. The ids, labels and routes are the real catalog's (`model-catalog.ts` in
 * kernel).
 */
export function modelOption(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'kimi-k2.7',
    label: 'Kimi K2.7',
    description: "Moonshot AI's 1T-param agentic-coding model with a 256K context.",
    flavor: 'cloudflare',
    available: true,
    providerLabel: 'Cloudflare',
    provider: 'workers-ai',
    model: '@cf/moonshotai/kimi-k2.7-code',
    cachesPrompts: false,
    contextTokens: 262_144,
    ...overrides,
  }
}

/**
 * A catalog where only the Claude subscription is connected: Claude Opus 5 is usable, and Kimi
 * K2.7 and GLM-5.3 are not, because Workers AI is not enabled. The built-in default preset is
 * all Kimi, so it points at a model the workspace cannot run.
 */
export const claudeOnlyCatalog: ModelOption[] = [
  modelOption({ available: false }),
  modelOption({
    id: 'glm-5.3',
    label: 'GLM-5.3',
    description: "Z.ai's newest agentic-coding model.",
    available: false,
    model: '@cf/zai-org/glm-5.3',
    // The Workers AI route's window. 1,310,720 is the OpenRouter route's.
    contextTokens: 1_048_576,
  }),
  modelOption({
    id: 'claude-opus',
    label: 'Claude Opus 5',
    description: "Anthropic's flagship agentic-coding model, run through Claude Code.",
    flavor: 'subscription',
    providerLabel: 'Claude',
    provider: 'anthropic',
    model: 'claude-opus-5',
    vendor: 'claude',
    quotaBased: true,
    cachesPrompts: true,
    contextTokens: 1_000_000,
  }),
]

/** The Acme account's own keys: an Anthropic key every board shares, and an OpenRouter gateway. */
export const accountApiKeys: ApiKey[] = [
  apiKey({
    id: 'key_anthropic_acme',
    scope: 'account',
    scopeId: orgAccount.id,
    provider: 'anthropic',
    label: 'Acme Anthropic',
    inputTokens: 18_402_000,
    outputTokens: 2_915_400,
    requestCount: 5_210,
  }),
  apiKey({
    id: 'key_openrouter_acme',
    scope: 'account',
    scopeId: orgAccount.id,
    label: 'Acme OpenRouter',
    isDefault: false,
  }),
]

/**
 * The Acme runner pool's manifest: a scheduler API that takes a job, is polled for its state and
 * releases it. Written for these stories. `runnerPoolConnection` was registered from it.
 */
export const runnerPoolManifest = {
  providerId: runnerPoolConnection.providerId,
  label: runnerPoolConnection.label,
  baseUrl: runnerPoolConnection.baseUrl,
  auth: { type: 'bearer', secretRef: { key: 'apiToken' } },
  dispatch: { method: 'POST', pathTemplate: '/v1/jobs', bodyTemplate: '{{input.job}}' },
  poll: { method: 'GET', pathTemplate: '/v1/jobs/{{input.jobId}}' },
  release: { method: 'DELETE', pathTemplate: '/v1/jobs/{{input.jobId}}' },
  response: {
    statusPath: 'state',
    statusMap: [
      { from: 'queued', to: 'running' },
      { from: 'running', to: 'running' },
      { from: 'succeeded', to: 'done' },
      { from: 'failed', to: 'failed' },
    ],
    resultPath: 'result',
  },
}

/**
 * How the runner pool's manifest backend describes itself once connected: a field per secret the
 * manifest names, labelled with its key, and the saved manifest. No template, so the panel shows
 * the manifest editor.
 */
export const manifestRunnerDescriptor: ProviderDescriptor = {
  providerId: runnerPoolConnection.providerId,
  label: runnerPoolConnection.label,
  kind: 'manifest',
  configFields: [{ key: 'apiToken', label: 'apiToken', secret: true, required: true }],
  supportsTest: true,
  missingRequired: [],
  savedManifest: runnerPoolManifest,
}

/**
 * The Kubernetes runner backend's connect form, a copy of `KUBERNETES_RUNNER_FORM_FIELDS` and
 * the token field (`kubernetes.logic.ts` and `kubernetes-runner-backend.ts` in integrations).
 */
const kubernetesRunnerFields: ProviderDescriptor['configFields'] = [
  { key: 'label', label: 'Name', required: true, placeholder: 'prod cluster' },
  {
    key: 'apiServerUrl',
    label: 'API server URL',
    required: true,
    placeholder: 'https://10.0.0.1:6443',
  },
  { key: 'namespace', label: 'Namespace', required: true, placeholder: 'cat-factory' },
  {
    key: 'image',
    label: 'Executor image',
    required: true,
    placeholder: 'ghcr.io/kibertoad/cat-factory-executor:latest',
  },
  {
    key: 'imageUi',
    label: 'UI-tester image',
    help: 'The heavier Playwright image used for image:ui dispatches (optional).',
  },
  {
    key: 'caCertPem',
    label: 'API server CA (PEM)',
    type: 'textarea',
    help: 'PEM CA bundle verifying the apiserver cert. Omit only for a publicly-trusted CA.',
  },
  { key: 'harnessPort', label: 'Harness port', type: 'number', default: '27182' },
  {
    key: 'insecureSkipTlsVerify',
    label: 'Skip TLS verification',
    type: 'checkbox',
    help: 'Strongly discouraged; kind/dev clusters only.',
  },
  {
    key: 'apiToken',
    label: 'ServiceAccount token',
    secret: true,
    required: true,
    help: 'A long-lived (or projected) token for the ServiceAccount the backend calls the apiserver as.',
  },
]

/** Agent containers run as pods on the Acme build cluster. */
export const kubernetesRunnerConnection: RunnerPoolConnection = {
  kind: 'kubernetes',
  providerId: 'kubernetes',
  label: 'Acme build cluster',
  baseUrl: 'https://k8s.build.acme.dev:6443',
  connectedAt: Date.UTC(2026, 9, 2),
  secretKeys: ['apiToken'],
  config: {
    kind: 'kubernetes',
    kubernetes: {
      label: 'Acme build cluster',
      apiServerUrl: 'https://k8s.build.acme.dev:6443',
      namespace: 'cat-factory-runs',
      image: 'ghcr.io/kibertoad/cat-factory-executor:1.163.4',
    },
  },
}

/**
 * How the Kubernetes runner backend describes itself: connected to the Acme build cluster, with
 * its values to prefill the form, or not connected, with every required field missing.
 */
export function kubernetesRunnerDescriptor(connected: boolean): ProviderDescriptor {
  if (!connected) {
    return {
      providerId: 'kubernetes',
      label: 'Kubernetes',
      kind: 'native',
      configFields: kubernetesRunnerFields,
      supportsTest: true,
      missingRequired: ['label', 'apiServerUrl', 'namespace', 'image', 'apiToken'],
      configTemplate: { kind: 'kubernetes', kubernetes: {} },
      values: {},
    }
  }
  const stored = kubernetesRunnerConnection.config!
  return {
    providerId: kubernetesRunnerConnection.providerId,
    label: kubernetesRunnerConnection.label,
    kind: 'native',
    configFields: kubernetesRunnerFields,
    supportsTest: true,
    missingRequired: [],
    configTemplate: stored,
    values: {
      label: 'Acme build cluster',
      apiServerUrl: 'https://k8s.build.acme.dev:6443',
      namespace: 'cat-factory-runs',
      image: 'ghcr.io/kibertoad/cat-factory-executor:1.163.4',
    },
  }
}

/**
 * How the Kubernetes environment backend describes itself before a connection: its bespoke form
 * collects the cluster, so the one field it names is the token, still missing.
 */
export const kubernetesEnvironmentDescriptor: ProviderDescriptor = {
  providerId: 'kubernetes',
  label: 'Kubernetes',
  kind: 'native',
  configFields: [{ key: 'apiToken', label: 'ServiceAccount token', secret: true, required: true }],
  supportsTest: true,
  supportsRepoValidation: false,
  supportsRepoBootstrap: false,
  missingRequired: ['apiToken'],
}

/**
 * A catalog with the Claude subscription connected and Workers AI enabled: Kimi K2.7, GLM-5.2 and
 * Claude Opus 5 are usable, and GPT-5.6 Sol is not, because nothing connects OpenRouter or a
 * ChatGPT plan. The four models the built-in presets name.
 */
export const presetModelCatalog: ModelOption[] = [
  modelOption(),
  modelOption({
    id: 'glm',
    label: 'GLM-5.2',
    description:
      "Z.ai's agentic-coding model: 256K context on Cloudflare, or the full 1M-token window via a " +
      'GLM (Z.ai) subscription.',
    model: '@cf/zai-org/glm-5.2',
  }),
  { ...claudeOnlyCatalog[2]!, available: true },
  modelOption({
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description:
      "OpenAI's flagship for complex coding and research, run via Codex on a ChatGPT " +
      'subscription, or pay-as-you-go through OpenRouter.',
    available: false,
    flavor: 'openrouter',
    providerLabel: 'OpenRouter',
    provider: 'openrouter',
    model: 'openai/gpt-5.6-sol',
    contextTokens: 1_050_000,
  }),
]

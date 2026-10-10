import type {
  ConnectionTestResult,
  EnvironmentConnectionRecord,
  EnvironmentManifest,
  EnvironmentProvider,
  InfraEngine,
  ProvisionType,
  SavedConnectionProbe,
  SecretResolver,
  TestEnvironmentConnectionInput,
  TestEnvironmentHandlerInput,
  UrlSafetyPolicy,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type {
  EnvironmentBackendProvider,
  EnvironmentBackendRegistry,
} from './environment-backends.js'
import {
  handlerConfigToBackendConfig,
  overlaySecrets,
  resolveHandlerBackend,
} from './infra-handler-build.js'

// The environment module's CONNECTION PROBES — "can we actually reach this?", in the three shapes
// the product asks it: a candidate config an operator is about to save, a candidate per-type
// handler, and the SAVED connection a background sweep re-checks. Extracted from
// `EnvironmentConnectionService` (which keeps thin delegates) as one cohesive collaborator over a
// deps object of bound callbacks: they are the only methods that answer a liveness question rather
// than reading or writing connection state, and the distinction between them is subtle enough to be
// worth stating in one place.
//
// The distinction: `testConnection`/`testHandler` answer "would this config work" for an operator
// staring at a form, so they ASSERT config safety. `probeSavedConnection` answers "does what we
// already stored still answer", and deliberately asserts nothing — re-running `assertConfigSafe`
// against an already-persisted connection would report it as an outage the moment a deployment
// tightened its URL policy.

/** Bound collaborators the probes need from the owning service (no state of their own). */
export interface EnvironmentConnectionProbeDeps {
  workspaceRepository: WorkspaceRepository
  environmentBackendRegistry: EnvironmentBackendRegistry
  /** The conformance-suite provider override, when injected; else the registry path. */
  environmentProvider?: EnvironmentProvider
  urlPolicy?: UrlSafetyPolicy
  customTlsSupported?: boolean
  requireBackend: (kind: string) => EnvironmentBackendProvider
  buildProvider: (backend: EnvironmentBackendProvider) => EnvironmentProvider
  primaryRecord: (workspaceId: string) => Promise<EnvironmentConnectionRecord | null>
  buildFromRecord: (record: EnvironmentConnectionRecord) => {
    provider: EnvironmentProvider
    manifest: EnvironmentManifest
  }
  buildResolveSecret: (record: EnvironmentConnectionRecord) => Promise<SecretResolver>
  storedSecretsFor: (
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
  ) => Promise<Record<string, string>>
  engineToProvisionType: (engine: InfraEngine) => ProvisionType
}

export function createEnvironmentConnectionProbes(deps: EnvironmentConnectionProbeDeps) {
  /** The write-boundary safety options (URL policy + this runtime's TLS capability). */
  const safetyOptions = () => ({
    ...(deps.urlPolicy ? { urlPolicy: deps.urlPolicy } : {}),
    ...(deps.customTlsSupported !== undefined
      ? { customTlsSupported: deps.customTlsSupported }
      : {}),
  })

  /**
   * Probe a candidate connection before saving (nothing is persisted). Builds the backend's
   * provider from the candidate config + a resolver over the supplied (unsaved) secrets and
   * delegates to the provider's `testConnection`.
   */
  async function testConnection(
    workspaceId: string,
    input: TestEnvironmentConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(deps.workspaceRepository, workspaceId)
    if (!input.config) return { ok: true, message: 'Nothing to test.' }
    const backend = deps.requireBackend(input.config.kind)
    backend.assertConfigSafe(input.config, safetyOptions())
    const provider = deps.buildProvider(backend)
    if (!provider.testConnection) {
      return { ok: true, message: 'This provider has no connection test.' }
    }
    const manifest = backend.toManifest(input.config)
    const secrets = input.secrets ?? {}
    return provider.testConnection({
      manifest,
      config: {},
      resolveSecret: (key) => secrets[key],
    })
  }

  /**
   * Probe the workspace's SAVED primary connection, for the reachability watcher. Resolves the
   * stored record + its own secret bundle rather than taking candidate values, and makes NO safety
   * assertion (see the module note).
   *
   * Never `{ ok: false }` for anything but a provider that actually ANSWERED negatively: the three
   * {@link SavedConnectionProbe} states keep "nothing is registered" (a fact — no outage to report,
   * and any recorded one must be forgotten) apart from "we could not ask" (a provider with no
   * connection test — leave the record alone) apart from a real verdict. An unprobeable provider
   * that read as `{ ok: false }` would show as permanently down.
   */
  async function probeSavedConnection(workspaceId: string): Promise<SavedConnectionProbe> {
    const record = await deps.primaryRecord(workspaceId)
    if (!record) return { state: 'absent' }
    const { provider, manifest } = deps.buildFromRecord(record)
    const live = deps.environmentProvider ?? provider
    if (!live.testConnection) {
      return { state: 'unprobeable', reason: 'This environment provider has no connection test.' }
    }
    return {
      state: 'answered',
      result: await live.testConnection({
        manifest,
        config: {},
        resolveSecret: await deps.buildResolveSecret(record),
      }),
    }
  }

  /**
   * Probe a candidate per-type infra HANDLER connection before saving (nothing persisted).
   * Lowers the engine-discriminated handler config to the backend config — with a placeholder
   * manifest source, since a connectivity probe reads only the apiserver/token, never the
   * (service-owned) source — and delegates to {@link testConnection}. So the per-type engine
   * form (e.g. a `local-k3s` / `remote-kubernetes` Kubernetes engine) can verify the apiserver
   * is reachable and the token authenticates before the operator commits the handler.
   */
  async function testHandler(
    workspaceId: string,
    input: TestEnvironmentHandlerInput,
  ): Promise<ConnectionTestResult> {
    const backend = resolveHandlerBackend(
      deps.environmentBackendRegistry,
      input.config.engine,
      input.backendKind,
    )
    const backendConfig = handlerConfigToBackendConfig(input.config, backend.kind)
    // Fall back to the SAVED handler's stored secrets so an operator can (re)test an existing
    // connection — or edit a non-secret field and test it — WITHOUT re-entering the write-only
    // token the edit form never surfaces. A freshly-typed secret still overrides the stored one;
    // a blank/omitted value preserves it (see overlaySecrets).
    const provisionType = deps.engineToProvisionType(input.config.engine)
    const manifestId =
      input.config.engine === 'remote-custom' ? input.config.acceptsManifestId : null
    const stored = await deps.storedSecretsFor(workspaceId, provisionType, manifestId)
    const secrets = overlaySecrets(stored, input.secrets)
    return testConnection(workspaceId, { config: backendConfig, secrets })
  }

  return { testConnection, probeSavedConnection, testHandler }
}

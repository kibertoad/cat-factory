// The answers to the provider connections' probe (`providerConnections.ensureLoaded`), which the
// board's provider banner and the setup checklist start when they open: each of the two
// infrastructure providers (test environments and the runner pool) describes itself and returns
// its saved connection. A provider that still misses a value it requires names it in
// `missingRequired`. One provider's two reads alone, with any description and connection, are
// `runnerPoolConnectionApi` and `environmentConnectionApi`, for the panels that connect one. The
// board's environment handlers and the test of a saved Kubernetes handler are
// `environmentHandlersApi` and `environmentHandlerTestApi`.
import {
  describeEnvironmentProviderContract,
  describeRunnerPoolProviderContract,
  getEnvironmentConnectionContract,
  getRunnerPoolConnectionContract,
  listEnvironmentHandlersContract,
  testEnvironmentHandlerContract,
} from '@cat-factory/contracts'
import type {
  ConnectionTestResult,
  CustomManifestType,
  EnvironmentConnection,
  EnvironmentHandlerView,
  ProviderDescriptor,
  RunnerPoolConnection,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import {
  environmentConnection,
  providerDescriptor,
  runnerPoolConnection,
} from './providers.stories.mocks'

export function providerProbeApi({
  environmentMissing = [],
  runnerMissing = [],
}: { environmentMissing?: string[]; runnerMissing?: string[] } = {}): HttpHandler[] {
  return [
    ...environmentConnectionApi({
      descriptor: providerDescriptor(environmentConnection, environmentMissing),
      connection: environmentConnection,
    }),
    ...runnerPoolConnectionApi({
      descriptor: providerDescriptor(runnerPoolConnection, runnerMissing),
      connection: runnerPoolConnection,
    }),
  ]
}

/**
 * The runner pool's two reads: how its backend describes itself and the board's stored
 * connection, or none. The describe answer is the same for every backend kind the panel asks
 * about.
 */
export function runnerPoolConnectionApi(seed: {
  descriptor: ProviderDescriptor
  connection?: RunnerPoolConnection | null
}): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    apiResponse(describeRunnerPoolProviderContract, { pathPrefix, body: seed.descriptor }),
    apiResponse(getRunnerPoolConnectionContract, {
      pathPrefix,
      body: { connection: seed.connection ?? null },
    }),
  ]
}

/** The same two reads for the test environment provider. */
export function environmentConnectionApi(seed: {
  descriptor: ProviderDescriptor
  connection?: EnvironmentConnection | null
}): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    apiResponse(describeEnvironmentProviderContract, { pathPrefix, body: seed.descriptor }),
    apiResponse(getEnvironmentConnectionContract, {
      pathPrefix,
      body: { connection: seed.connection ?? null },
    }),
  ]
}

/** The board's environment handlers and custom provision types, as the handler read answers. */
export function environmentHandlersApi(
  handlers: EnvironmentHandlerView[],
  customTypes: CustomManifestType[],
): HttpHandler {
  return apiResponse(listEnvironmentHandlersContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { handlers, customTypes },
  })
}

/** The verdict of a handler test, which a saved Kubernetes handler runs when it shows. */
export function environmentHandlerTestApi(result: ConnectionTestResult): HttpHandler {
  return apiResponse(testEnvironmentHandlerContract, {
    pathPrefix: storyWorkspacePrefix,
    body: result,
  })
}

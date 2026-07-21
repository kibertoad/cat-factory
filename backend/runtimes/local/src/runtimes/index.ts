import {
  type ContainerRuntimeAdapter,
  resolveHostAlias,
  resolveInstallId,
  resolveRuntimeId,
  runtimeProfile,
} from './containerRuntime.js'
import { DockerRuntimeAdapter } from './dockerRuntime.js'
import { AppleContainerRuntimeAdapter } from './appleContainerRuntime.js'

export * from './containerRuntime.js'
export { DockerRuntimeAdapter } from './dockerRuntime.js'
export { AppleContainerRuntimeAdapter } from './appleContainerRuntime.js'

/**
 * Build the container-runtime adapter selected by `LOCAL_CONTAINER_RUNTIME`
 * (docker | podman | orbstack | colima | apple), applying the env overrides
 * (`LOCAL_DOCKER_BINARY`, `LOCAL_DOCKER_ADD_HOST_GATEWAY`, `LOCAL_HARNESS_HOST_ALIAS`)
 * on top of the runtime's profile defaults. Docker/Podman/OrbStack/Colima share the
 * Docker-CLI adapter; Apple `container` gets its own.
 */
export function createRuntimeAdapter(env: NodeJS.ProcessEnv): ContainerRuntimeAdapter {
  const profile = runtimeProfile(resolveRuntimeId(env))
  const binary = env.LOCAL_DOCKER_BINARY?.trim() || profile.binary
  const hostAlias = resolveHostAlias(env)
  // Namespaces every managed container by installation so a shared container daemon can't cross
  // installs (ADR 0026 D5). Preview + deploy transports build through here too, so they inherit
  // the same id and land in the same namespace as this install's runs.
  const installId = resolveInstallId(env)

  if (profile.family === 'apple') {
    return new AppleContainerRuntimeAdapter({ binary, hostAlias, installId })
  }

  // An explicit LOCAL_DOCKER_ADD_HOST_GATEWAY wins; otherwise the profile default
  // (Colima defaults off — host-gateway resolves to the Lima VM, not the Mac host).
  const explicit = env.LOCAL_DOCKER_ADD_HOST_GATEWAY?.trim()
  const addHostGateway = explicit ? explicit !== 'false' : profile.addHostGateway

  return new DockerRuntimeAdapter({
    id: profile.id,
    binary,
    hostAlias,
    addHostGateway,
    localDind: profile.localDind,
    pooling: profile.pooling,
    installId,
  })
}

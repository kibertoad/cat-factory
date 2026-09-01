// Which hosts an agent container must have re-pointed to reach the environments a run handed it,
// what to re-point each one AT, and which of them no container can ever reach.
//
// The RULE lives in kernel (`classifyLocalMachineHostBridge`, in
// `shared/environment-host-bridge.logic.ts`), which is also where the reasoning is: why a loopback
// environment URL is a dead end inside a container, why the fix is to make the ONE name mean the
// right thing in each place rather than to publish a second URL, why `localhost` and a bare IP
// literal are local names no hosts-file entry can re-point, and which addresses a bridge may name.
// What lives here is the URL half, because kernel compiles with no `URL`.
//
// Here rather than beside one transport because TWO of them build the same bridges out of the same
// dispatch options and cannot be allowed to disagree: the local Docker/Podman transport emits
// `--add-host`, and the Kubernetes runner transport emits a pod's `hostAliases`. A name-to-address
// mapping is expressible in both. Only the `host-gateway` target is Docker-family-specific, which
// is why it is a discriminated target rather than a second list.

import type { DispatchEnvironment, HostBridgeTarget } from '@cat-factory/kernel'
import { classifyLocalMachineHostBridge, hostBridgeKey } from '@cat-factory/kernel'

/** One name a container must have re-pointed, and what to re-point it at. */
export interface HostBridge {
  host: string
  target: HostBridgeTarget
}

/** What a job's environments mean for the container the transport is about to start. */
export interface EnvironmentBridgePlan {
  /**
   * The bridges to install, deduplicated and sorted by {@link hostBridgeKey}.
   *
   * Sorted because this list is compared against what a running container was CREATED with, and
   * recorded on its handle; an order that varied with the order the engine happened to list a
   * run's peers would make two identical bridge sets look different and replace a container for
   * nothing.
   */
  bridges: readonly HostBridge[]
  /**
   * The URLs that name this machine and that no bridge reaches: a compose environment published on
   * `http://localhost:<port>`, or one published on a bare loopback address.
   *
   * Carried rather than dropped because "nothing to bridge" and "unreachable and unfixable here"
   * are opposite facts that would otherwise render identically, and the second is a run that is
   * going to spend its tester step on connection failures. The transport says so once at dispatch;
   * nothing downstream branches on it.
   */
  unbridgeable: readonly string[]
}

/** The hostname of `url`, or null when it has none or is not a URL (never a guess). */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * Grade every environment a job was handed for the host bridge.
 *
 * Takes the WHOLE list rather than one environment because a job is routinely handed several: its
 * own ephemeral environment, a live peer service's environment for a cross-service integration
 * test, and a frontend flow's resolved backend bindings. Bridging only the first one is how the
 * bridge came to fire for a tester's own environment and not for the peer it was testing against,
 * which fails in exactly the same way and reads as exactly the same "the environment is down".
 *
 * The address a bridge may name comes off the environment it belongs to, never out of a shared bag
 * keyed by hostname, and that pairing is the security property: the HOST side of every bridge is,
 * structurally, a host this job was handed. A free-form map would let a provider re-point any name
 * inside the container, including the harness's own alias for reaching back to its host.
 */
export function planEnvironmentBridges(
  environments: readonly (DispatchEnvironment | null | undefined)[],
): EnvironmentBridgePlan {
  const bridges = new Map<string, HostBridge>()
  const unbridgeable = new Set<string>()
  for (const environment of environments) {
    if (!environment?.url) continue
    const hostname = hostnameOf(environment.url)
    if (!hostname) continue
    const verdict = classifyLocalMachineHostBridge(hostname, environment.address)
    if (verdict.kind === 'bridge') {
      bridges.set(hostBridgeKey(verdict), { host: verdict.host, target: verdict.target })
    } else if (verdict.kind === 'unbridgeable') {
      unbridgeable.add(environment.url)
    }
  }
  return {
    bridges: [...bridges.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v),
    unbridgeable: [...unbridgeable].sort(),
  }
}

/**
 * The bridges expressible as a NAME-TO-ADDRESS mapping, which is every bridge except a
 * `host-gateway` one.
 *
 * A runtime with no host-gateway concept (a Kubernetes pod, whose `hostAliases` entries are
 * `{ ip, hostnames[] }`) can honour the address half and genuinely cannot honour the other. The
 * split is stated here so each such transport reads the same answer rather than filtering the
 * union inline and quietly disagreeing about what it dropped.
 */
export function addressBridges(bridges: readonly HostBridge[]): { host: string; ip: string }[] {
  return bridges
    .filter(
      (bridge): bridge is { host: string; target: { ip: string } } =>
        bridge.target !== 'host-gateway',
    )
    .map((bridge) => ({ host: bridge.host, ip: bridge.target.ip }))
}

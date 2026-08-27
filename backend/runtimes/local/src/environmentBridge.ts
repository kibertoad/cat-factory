// Which hosts an agent container must have bridged to its host gateway to reach the environments a
// run handed it, and which of those it can never reach whatever this transport does.
//
// The RULE lives in kernel (`classifyLocalMachineHostBridge`, in
// `shared/environment-host-bridge.logic.ts`), which is also where the reasoning is: why a loopback
// environment URL is a dead end inside a container, why the fix is to make the ONE name mean the
// right thing in each place rather than to publish a second URL, and why `localhost` and a bare IP
// literal are local names no hosts-file entry can re-point. What lives here is the URL half,
// because kernel compiles with no `URL`.

import { classifyLocalMachineHostBridge } from '@cat-factory/kernel'

/** What a job's environment URLs mean for the container the transport is about to start. */
export interface EnvironmentBridgePlan {
  /**
   * Hostnames to map onto the container's host gateway, deduplicated and sorted.
   *
   * Sorted because this list is compared against what a running container was CREATED with, and
   * recorded on its handle; an order that varied with the order the engine happened to list a
   * run's peers would make two identical bridge sets look different and replace a container for
   * nothing.
   */
  hosts: readonly string[]
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
 * Grade every URL a job was handed for the host bridge.
 *
 * Takes the WHOLE list rather than one URL because a job is routinely handed several: its own
 * ephemeral environment, a live peer service's environment for a cross-service integration test,
 * and a frontend flow's resolved backend bindings. Bridging only the first one is how the bridge
 * came to fire for a tester's own environment and not for the peer it was testing against, which
 * fails in exactly the same way and reads as exactly the same "the environment is down".
 */
export function planEnvironmentBridges(
  urls: readonly (string | null | undefined)[],
): EnvironmentBridgePlan {
  const hosts = new Set<string>()
  const unbridgeable = new Set<string>()
  for (const url of urls) {
    if (!url) continue
    const hostname = hostnameOf(url)
    if (!hostname) continue
    const verdict = classifyLocalMachineHostBridge(hostname)
    if (verdict.kind === 'bridge') hosts.add(verdict.host)
    else if (verdict.kind === 'unbridgeable') unbridgeable.add(url)
  }
  return { hosts: [...hosts].sort(), unbridgeable: [...unbridgeable].sort() }
}

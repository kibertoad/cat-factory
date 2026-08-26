// Which host an agent container must have bridged to its host gateway to reach a run's ephemeral
// environment.
//
// The RULE lives in kernel (`resolvesToLocalMachine`, in `shared/environment-host-bridge.logic.ts`),
// which is also where the reasoning is: why a loopback environment URL is a dead end inside a
// container, and why the fix is to make the ONE name mean the right thing in each place rather than
// to publish a second URL. What lives here is the URL half, because kernel compiles with no `URL`.

import { resolvesToLocalMachine } from '@cat-factory/kernel'

/**
 * The hostname a containerized agent needs bridged to reach `url`, or null when it needs nothing.
 *
 * Null is the answer for every case that already works, and that is the important half rather than
 * a fallback: a bridge applied where it is not needed is strictly harmful. Mapping a genuinely
 * remote environment host (`pr8.staging.example.com`, a public address) onto the container's host
 * gateway would take an environment that WAS reachable and break it. So a host is returned only
 * when its own answer is this machine, and an unparseable or hostless URL returns null rather than
 * guessing.
 */
export function environmentHostNeedingBridge(url: string | null | undefined): string | null {
  if (!url) return null
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }
  if (!hostname) return null
  return resolvesToLocalMachine(hostname) ? hostname : null
}

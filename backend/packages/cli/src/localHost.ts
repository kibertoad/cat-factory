// `isLocalMachineHost` is a deliberate COPY of kernel's helper of the same name, for the same
// reason `errorText.ts` copies `getErrorMessage`: this package is published and stays runtime
// dependency-free, so shipped code cannot import a `workspace:*` package. That import resolves
// through pnpm's link in every local run and is simply absent on the registry, so the failure
// reaches whoever runs `npx cat-factory` and nobody before them.
//
// A copy is only acceptable if it cannot drift, and `localHost.conformity.test.ts` pins the two
// to the same answer over the hosts a kubeconfig actually carries. Kernel is a DEVdependency,
// which is what makes that test's import legal where this file's would not be.

/**
 * Hostnames that reach the machine this process runs on without being loopback ADDRESSES: the
 * wildcard bind addresses a tool writes into a config when it listened on every interface, and
 * the aliases a container runtime publishes for its host.
 */
const LOCAL_MACHINE_ALIASES = new Set([
  '0.0.0.0',
  '::',
  'host.docker.internal',
  'kubernetes.docker.internal',
  'gateway.docker.internal',
])

/** Whether a hostname is loopback: `localhost`, any `127.x.x.x`, or the IPv6 `::1`. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * Whether a hostname names THIS machine, over any of the spellings a local toolchain produces.
 *
 * Wider than loopback on purpose: the two spellings a local cluster actually writes into a
 * kubeconfig are k3d's wildcard `0.0.0.0` and Docker Desktop's `kubernetes.docker.internal`, so a
 * bare loopback test excludes the default setup of both. Narrower than "private": a shared
 * staging cluster on 10.x is somebody else's machine however private its address.
 */
export function isLocalMachineHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopbackHost(host)) return true
  if (LOCAL_MACHINE_ALIASES.has(host)) return true
  // RFC 6761 reserves the whole `.localhost` tree to loopback.
  return host.endsWith('.localhost')
}

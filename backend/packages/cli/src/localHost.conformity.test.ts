import { isLocalMachineHost as kernelIsLocalMachineHost } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { isLocalMachineHost } from './localHost.js'

// `src/localHost.ts` is a deliberate COPY of kernel's `isLocalMachineHost` (this package is
// published and stays runtime dependency-free, so shipped code cannot import a `workspace:*`
// package). A copy is only acceptable if it cannot drift, so this suite pins the two to the same
// answer. Kernel is a DEVdependency, which is exactly what makes this import legal.
//
// The drift this guards is not hypothetical: the CLI and the Kubernetes environment provider each
// carried their own list of "hostnames that mean this machine", and the CLI's was missing the
// wildcard address k3d writes into every kubeconfig it generates. One of them then gated a
// behaviour on a set that excluded the most common local cluster, and nothing failed.

const CORPUS = [
  // Loopback, in each spelling a kubeconfig or a flag can carry.
  'localhost',
  '127.0.0.1',
  '127.1.2.3',
  '::1',
  '[::1]',
  'LOCALHOST',
  // The wildcard bind addresses a tool writes after listening on every interface.
  '0.0.0.0',
  '::',
  // Container-runtime host aliases.
  'host.docker.internal',
  'kubernetes.docker.internal',
  'gateway.docker.internal',
  'anything.localhost',
  // Private, and therefore somebody else's machine.
  '10.4.1.9',
  '192.168.1.20',
  '172.16.0.1',
  '169.254.169.254',
  // Public and other.
  'api.k8s.example.com',
  'cluster.internal',
  'k3s.local',
  '',
]

describe('CLI isLocalMachineHost conforms to kernel isLocalMachineHost', () => {
  for (const host of CORPUS) {
    it(`agrees on '${host}'`, () => {
      expect(isLocalMachineHost(host)).toBe(kernelIsLocalMachineHost(host))
    })
  }

  // Asserted directly as well, so a conforming-but-wrong pair (both drifting the same way) still
  // fails. These are the answers the gate's safety depends on in each direction.
  it('accepts the default local kubeconfigs and refuses a shared cluster', () => {
    expect(isLocalMachineHost('0.0.0.0')).toBe(true)
    expect(isLocalMachineHost('kubernetes.docker.internal')).toBe(true)
    expect(isLocalMachineHost('10.4.1.9')).toBe(false)
    expect(isLocalMachineHost('api.k8s.example.com')).toBe(false)
  })
})

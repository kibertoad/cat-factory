import { describe, expect, it } from 'vitest'
import {
  infrastructureTabs,
  openInfrastructureTab,
  repinInfrastructureTab,
} from './InfrastructureWindow.logic'

const NONE = {
  agents: false,
  environments: false,
  packageRegistries: false,
  capabilityCredentials: false,
}

describe('infrastructureTabs', () => {
  it('shows nothing when no probe reports a backend', () => {
    expect(infrastructureTabs(NONE)).toEqual([])
  })

  it('rides the environment probe for shared stacks', () => {
    // A shared stack is infra a Tester environment ATTACHES to, so it cannot stand on its own:
    // without an environment backend there is nothing to attach it to.
    expect(infrastructureTabs({ ...NONE, environments: true })).toEqual([
      'environment',
      'shared-stacks',
    ])
  })

  it('gates the registries tab on its own module probe', () => {
    // The backend 503s the module with no encryption key. That is independent of any execution
    // or test-env backend, so the tab can be the ONLY one a deployment shows.
    expect(infrastructureTabs({ ...NONE, packageRegistries: true })).toEqual(['package-registries'])
    expect(infrastructureTabs({ ...NONE, agents: true })).toEqual(['runner-pool'])
  })

  it('gates the capability-credentials tab on its own two-part probe', () => {
    // Unlike its neighbours this one also gates on CONTENT: the panel is a checklist projected
    // from the deployment's registered capabilities, so a build that registers none has no
    // credential to type. The window folds that (and the `secrets.manage` check) into the flag.
    expect(infrastructureTabs({ ...NONE, capabilityCredentials: true })).toEqual([
      'capability-credentials',
    ])
  })

  it('orders tabs by the question they answer, not by which probe resolved', () => {
    expect(
      infrastructureTabs({
        agents: true,
        environments: true,
        packageRegistries: true,
        capabilityCredentials: true,
      }),
    ).toEqual([
      'runner-pool',
      'environment',
      'shared-stacks',
      'package-registries',
      'capability-credentials',
    ])
  })
})

describe('openInfrastructureTab', () => {
  it('honours an available deep-linked tab over the first one', () => {
    expect(openInfrastructureTab(['runner-pool', 'package-registries'], 'package-registries')).toBe(
      'package-registries',
    )
  })

  it('falls back to the first available tab when the request is off', () => {
    expect(openInfrastructureTab(['runner-pool'], 'package-registries')).toBe('runner-pool')
  })

  it('keeps naming the requested tab when nothing is available yet', () => {
    // Every probe is still in flight on the first open. Holding the request (rather than
    // inventing a selection) is what lets the re-pin land on it the moment its probe resolves.
    expect(openInfrastructureTab([], 'package-registries')).toBe('package-registries')
  })
})

describe('repinInfrastructureTab', () => {
  it('leaves the user where they are when their tab is still available', () => {
    // The list GROWS as probes resolve; someone reading a tab must not be yanked off it.
    expect(
      repinInfrastructureTab(
        ['runner-pool', 'environment', 'package-registries'],
        'environment',
        'runner-pool',
        true,
      ),
    ).toBe('environment')
  })

  it('lands on the deep-linked tab once its probe resolves', () => {
    // The registries probe is the slow one: the window opened on `runner-pool` because
    // `package-registries` was not there yet, and this is the moment it arrives.
    expect(
      repinInfrastructureTab(
        ['runner-pool', 'package-registries'],
        'shared-stacks',
        'package-registries',
        true,
      ),
    ).toBe('package-registries')
  })

  it('does not steal the selection while the probes are still settling', () => {
    // A transient list holding only the fastest probe's tab. Falling back to it here would pin
    // the user to whichever probe won the race and then REJECT the deep link for being a peer
    // of the current tab.
    expect(
      repinInfrastructureTab(['runner-pool'], 'package-registries', 'package-registries', false),
    ).toBe('package-registries')
  })

  it('falls back to the first tab once loading settled and the request is unavailable', () => {
    expect(
      repinInfrastructureTab(['runner-pool'], 'package-registries', 'package-registries', true),
    ).toBe('runner-pool')
  })

  it('holds the current tab when settling left nothing available at all', () => {
    expect(repinInfrastructureTab([], 'environment', 'environment', true)).toBe('environment')
  })
})

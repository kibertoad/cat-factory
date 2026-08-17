import { PLATFORM_IMAGE_VARIANTS } from '@cat-factory/kernel'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import type { ExecutionContainer } from '../src/infrastructure/containers/ExecutionContainer'
import {
  agentContainerNamespace,
  deploymentContainerBinding,
  deploymentContainerBindings,
} from '../src/infrastructure/containers/runContainerNamespace'
import type { RunContainerNamespace } from '../src/infrastructure/containers/runContainerNamespace'
import type { UiTesterContainer } from '../src/infrastructure/containers/UiTesterContainer'

// The Worker's image-variant ROUTING. A container's image is pinned per class here, so picking the
// class IS picking the image, and every wrong answer is silent for a whole dispatch: a browser job
// on the plain class discovers it has no browser only after a checkout, an install and the model's
// first turns, then reports an `abort` a reader cannot tell apart from an app that would not boot.

// The namespaces are only ever compared by identity, so a labelled stub is enough. `get` is what
// `deploymentContainerBindings` uses to tell a real durable-object binding from a string or a queue.
const stub = (label: string): DurableObjectNamespace<ExecutionContainer> =>
  ({ label, get: () => ({}) }) as unknown as DurableObjectNamespace<ExecutionContainer>

const exec = stub('exec')
const ui = stub('ui') as unknown as DurableObjectNamespace<UiTesterContainer>

describe('agentContainerNamespace', () => {
  it('serves the executor class for the default image, named or omitted', () => {
    const resolve = agentContainerNamespace({ exec, ui })
    expect(resolve('default')).toBe(exec)
    expect(resolve('')).toBe(exec)
  })

  it('serves the UI class for `ui`, and refuses it when nothing is bound', () => {
    expect(agentContainerNamespace({ exec, ui })('ui')).toBe(ui)
    expect(() => agentContainerNamespace({ exec })('ui')).toThrow(/UI_CONTAINER/)
  })

  it('refuses `deploy` on the agent path as a registration mistake', () => {
    // Its own refusal rather than the shared one: the fix is a developer correcting a kind's
    // registration, not an operator adding a binding, and the two messages have to say so.
    expect(() => agentContainerNamespace({ exec, ui })('deploy')).toThrow(/DEPLOY_CONTAINER/)
  })

  it("serves a DEPLOYMENT's own variant from its binding", () => {
    const pixel = stub('pixel') as unknown as RunContainerNamespace
    const resolve = agentContainerNamespace({ exec, ui, deployment: { 'pixel-tools': pixel } })
    expect(resolve('pixel-tools')).toBe(pixel)
  })

  it('refuses an unbound deployment variant, naming the binding to add', () => {
    const resolve = agentContainerNamespace({ exec, ui, deployment: {} })
    expect(() => resolve('pixel-tools')).toThrow(/RUNNER_CONTAINER_PIXEL_TOOLS/)
  })

  it('never resolves a PLATFORM variant out of the deployment bindings', () => {
    // The structural property, derived from the platform picklist rather than restating the names:
    // each platform image has its own class and its own refusal, so none of them may be answered
    // by a deployment binding. Respelling the names in the routing branch is what breaks this:
    // a newly published platform image falls into the deployment half and is refused as unwired on
    // the one runtime that ships it. Every platform name is bound here to a decoy, so a variant
    // that reached the deployment map would return the decoy instead of throwing or serving a class.
    const decoy = stub('decoy') as unknown as RunContainerNamespace
    const deployment = Object.fromEntries(PLATFORM_IMAGE_VARIANTS.map((name) => [name, decoy]))
    const resolve = agentContainerNamespace({ exec, ui, deployment })
    for (const variant of PLATFORM_IMAGE_VARIANTS) {
      let served: RunContainerNamespace | undefined
      try {
        served = resolve(variant)
      } catch {
        continue // Refused by its own arm, which is one of the two right answers.
      }
      expect(served).not.toBe(decoy)
    }
  })
})

describe('deploymentContainerBindings', () => {
  it('keys every RUNNER_CONTAINER_* binding by the variant it serves', () => {
    // The env spelling and the variant spelling differ (a binding name cannot hold a hyphen), and
    // `deploymentContainerBinding` is the forward direction of the same mapping: the two must agree
    // or an operator binds a class the resolver never looks for.
    const bound = stub('pixel')
    const bindings = deploymentContainerBindings({ RUNNER_CONTAINER_PIXEL_TOOLS: bound })
    expect(bindings['pixel-tools']).toBe(bound)
    expect(deploymentContainerBinding('pixel-tools')).toBe('RUNNER_CONTAINER_PIXEL_TOOLS')
  })

  it('skips anything that merely LOOKS like a binding', () => {
    // What makes a binding real is that wrangler resolved it to a namespace. A string or a queue
    // under the same prefix is skipped so the variant refuses at dispatch as unwired, rather than
    // throwing something unreadable deep inside a `get()`.
    expect(
      deploymentContainerBindings({
        RUNNER_CONTAINER_PIXEL_TOOLS: 'a plain string',
        RUNNER_CONTAINER_FONTS: null,
        UI_CONTAINER: stub('ui'),
      }),
    ).toEqual({})
  })
})

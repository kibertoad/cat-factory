import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOverlayStack, type OverlayStack } from '@modular-vue/core'
import { trackForeignLayers } from '~/utils/foreignLayers'

/** A Reka-shaped layer as Nuxt UI portals it: a wrapper on `<body>` around the layer element. */
function openLayer(root: HTMLElement, role: string | null): HTMLElement {
  const wrapper = document.createElement('div')
  const layer = document.createElement('div')
  layer.setAttribute('data-dismissable-layer', '')
  layer.dataset.state = 'open'
  if (role) layer.setAttribute('role', role)
  wrapper.append(layer)
  root.append(wrapper)
  return layer
}

/** MutationObserver callbacks run as a microtask after the DOM change. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('trackForeignLayers', () => {
  let root: HTMLElement
  let stack: OverlayStack
  let stop: () => void

  beforeEach(() => {
    root = document.createElement('div')
    document.body.append(root)
    stack = createOverlayStack()
    stop = trackForeignLayers(root, stack)
  })

  afterEach(() => {
    stop()
    root.remove()
  })

  it('puts an open menu above the overlay under it, and gives the top back when it closes', async () => {
    const takeover = stack.push()
    const menu = openLayer(root, 'menu')
    await settle()
    expect(takeover.isTop()).toBe(false)

    menu.parentElement!.remove()
    await settle()
    expect(takeover.isTop()).toBe(true)
    expect(stack.size).toBe(1)
  })

  it('gives the top back when a layer starts its exit animation, before it leaves the DOM', async () => {
    const takeover = stack.push()
    const menu = openLayer(root, 'menu')
    await settle()

    menu.dataset.state = 'closed'
    await settle()
    expect(takeover.isTop()).toBe(true)
  })

  it('takes a ticket for each focus-taking role, and none for a tooltip', async () => {
    for (const role of ['menu', 'listbox', 'dialog', 'alertdialog']) openLayer(root, role)
    openLayer(root, null)
    await settle()
    expect(stack.size).toBe(4)
  })

  it('keeps open order, so a menu opened over a modal is the top layer', async () => {
    const takeover = stack.push()
    const modal = openLayer(root, 'dialog')
    await settle()
    const window = stack.push()
    expect(window.isTop()).toBe(true)

    // A menu opened inside the window goes above it, and closing the modal under both changes
    // nothing for the window.
    const menu = openLayer(root, 'menu')
    await settle()
    expect(window.isTop()).toBe(false)
    modal.parentElement!.remove()
    menu.parentElement!.remove()
    await settle()
    expect(window.isTop()).toBe(true)
    window.release()
    expect(takeover.isTop()).toBe(true)
  })

  it('counts a layer that was already open when tracking started', () => {
    stop()
    openLayer(root, 'dialog')
    stop = trackForeignLayers(root, stack)
    expect(stack.size).toBe(1)
  })

  it('releases every ticket when tracking stops', async () => {
    openLayer(root, 'menu')
    openLayer(root, 'dialog')
    await settle()
    stop()
    expect(stack.size).toBe(0)
  })
})

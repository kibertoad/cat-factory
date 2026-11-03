import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { captureNewApiKeyDeepLink } from './useNewApiKeyDeepLink'

function setUrl(search: string): void {
  history.replaceState(null, '', `/${search}`)
}

describe('captureNewApiKeyDeepLink', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setUrl('')
  })

  it('parses the link an integration builds, and strips only its own params', () => {
    setUrl(
      '?newApiKey=1&label=sainte-beuve&scope=decide&runsAsSelf=1&reach=memberships&ws=ws_1&keep=yes',
    )
    expect(captureNewApiKeyDeepLink()).toEqual({
      label: 'sainte-beuve',
      scope: 'decide',
      runsAsSelf: true,
      reach: 'memberships',
      workspaceId: 'ws_1',
    })
    expect(window.location.search).toBe('?keep=yes')
    expect(captureNewApiKeyDeepLink()).toBeNull()
  })

  it('opens the form at its defaults when the link names nothing else', () => {
    setUrl('?newApiKey=1')
    expect(captureNewApiKeyDeepLink()).toEqual({
      label: null,
      scope: null,
      runsAsSelf: false,
      reach: null,
      workspaceId: null,
    })
    expect(window.location.search).toBe('')
  })

  it('drops a reach this build does not know rather than guessing one', () => {
    setUrl('?newApiKey=1&runsAsSelf=1&reach=everything')
    expect(captureNewApiKeyDeepLink()).toMatchObject({ reach: null })
  })

  it('drops a scope this build does not know rather than guessing one', () => {
    setUrl('?newApiKey=1&scope=superuser')
    expect(captureNewApiKeyDeepLink()).toMatchObject({ scope: null })
  })

  it('cuts a label to what the form accepts', () => {
    setUrl(`?newApiKey=1&label=${'x'.repeat(200)}`)
    expect(captureNewApiKeyDeepLink()?.label).toHaveLength(120)
  })

  it('ignores a URL without the link, and leaves its query alone', () => {
    setUrl('?label=other&scope=admin')
    expect(captureNewApiKeyDeepLink()).toBeNull()
    expect(window.location.search).toBe('?label=other&scope=admin')
  })
})

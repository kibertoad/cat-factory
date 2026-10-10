import { describe, it, expect, beforeEach } from 'vitest'
import { createUiModals } from '~/stores/ui/modals'

/**
 * The `cat-factory k3s` CLI hand-off (`?infraSetup=local-k3s&…`), driven through the modals slice
 * directly (plain refs/functions, no Pinia) exactly as the overlay-host slice tests do.
 *
 * What is worth pinning here is the ARRIVAL, not the parsing: the CLI's whole promise is that the
 * operator lands on the one form it just filled in, and both halves of that (the tab AND the
 * section anchor within it) are set in this one function. The prefill is asserted alongside
 * because the deep link is the only thing that ever sets it.
 */
function openWith(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
}

const K3S_LINK =
  '?infraSetup=local-k3s&label=Local+k3s&apiServerUrl=https%3A%2F%2F127.0.0.1%3A6443' +
  '&namespaceTemplate=cf-env-pr%7B%7BpullNumber%7D%7D&hostTemplate=%7B%7Bnamespace%7D%7D.127.0.0.1.nip.io' +
  '&scheme=http&insecureSkipTlsVerify=1'

/** The link a cluster published on a NON-default host port produces. */
const CUSTOM_PORT_LINK = `${K3S_LINK}&ingressPort=18080`

/** The link the CLI emits when it could NOT establish that the cluster serves ingress URLs. */
const NO_INGRESS_LINK =
  '?infraSetup=local-k3s&label=Local+k3s&apiServerUrl=https%3A%2F%2F127.0.0.1%3A6443' +
  '&namespaceTemplate=cf-env-pr%7B%7BpullNumber%7D%7D&insecureSkipTlsVerify=1'

describe('consumeK3sSetupDeepLink', () => {
  beforeEach(() => {
    openWith('')
  })

  it('opens the Test-environments tab ANCHORED on the Kubernetes section', () => {
    const ui = createUiModals()
    openWith(K3S_LINK)
    ui.consumeK3sSetupDeepLink()

    expect(ui.infrastructureOpen.value).toBe(true)
    expect(ui.infrastructureTab.value).toBe('environment')
    // The tab opens on the default-provision picker, so without this the operator lands above
    // the form the CLI just described and has to scroll to find it.
    expect(ui.infrastructureScrollTarget.value).toBe('kubernetes')
    expect(ui.k3sSetupPrefill.value).toEqual({
      label: 'Local k3s',
      apiServerUrl: 'https://127.0.0.1:6443',
      namespaceTemplate: 'cf-env-pr{{pullNumber}}',
      hostTemplate: '{{namespace}}.127.0.0.1.nip.io',
      ingressPort: '',
      urlScheme: 'http',
      insecureSkipTlsVerify: true,
    })
  })

  it('carries a non-default ingress port SEPARATELY from the host template', () => {
    // The template is also the Ingress `host` a service's manifests declare, and Kubernetes rejects
    // a `host` with a port, so the port cannot ride inside it.
    const ui = createUiModals()
    openWith(CUSTOM_PORT_LINK)
    ui.consumeK3sSetupDeepLink()

    expect(ui.k3sSetupPrefill.value?.ingressPort).toBe('18080')
    expect(ui.k3sSetupPrefill.value?.hostTemplate).toBe('{{namespace}}.127.0.0.1.nip.io')
  })

  it('strips the ingress-port param too, so a reload does not re-seed it', () => {
    const ui = createUiModals()
    openWith(CUSTOM_PORT_LINK)
    ui.consumeK3sSetupDeepLink()
    expect(window.location.search).toBe('')
  })

  it('carries NO host template when the CLI could not verify the cluster serves one', () => {
    // The CLI omits the param rather than prefilling a template the cluster cannot serve; the
    // form treats it as required, so an empty value is what stops an unserved URL being saved.
    const ui = createUiModals()
    openWith(NO_INGRESS_LINK)
    ui.consumeK3sSetupDeepLink()

    expect(ui.k3sSetupPrefill.value?.hostTemplate).toBe('')
    expect(ui.k3sSetupPrefill.value?.ingressPort).toBe('')
    expect(ui.k3sSetupPrefill.value?.urlScheme).toBeUndefined()
    // The rest of the prefill still lands: a withheld field is not a withheld form.
    expect(ui.k3sSetupPrefill.value?.apiServerUrl).toBe('https://127.0.0.1:6443')
  })

  it('strips the params so a reload neither re-opens the window nor re-anchors it', () => {
    const ui = createUiModals()
    openWith(K3S_LINK)
    ui.consumeK3sSetupDeepLink()
    expect(window.location.search).toBe('')

    const reloaded = createUiModals()
    reloaded.consumeK3sSetupDeepLink()
    expect(reloaded.infrastructureOpen.value).toBe(false)
    expect(reloaded.infrastructureScrollTarget.value).toBeNull()
  })

  it('drops an UNCONSUMED anchor on close, so the next plain open does not scroll', () => {
    // The panel clears the target once it has scrolled. Closing before it rendered (the window
    // was dismissed, or the infra probe never resolved) must not leave the anchor armed.
    const ui = createUiModals()
    openWith(K3S_LINK)
    ui.consumeK3sSetupDeepLink()
    ui.closeProviderConnection()

    expect(ui.infrastructureScrollTarget.value).toBeNull()
    expect(ui.k3sSetupPrefill.value).toBeNull()
  })

  it('is a no-op for an unrelated query string', () => {
    const ui = createUiModals()
    openWith('?settings=default-test-env')
    ui.consumeK3sSetupDeepLink()

    expect(ui.infrastructureOpen.value).toBe(false)
    expect(ui.infrastructureScrollTarget.value).toBeNull()
    expect(window.location.search).toBe('?settings=default-test-env')
  })
})

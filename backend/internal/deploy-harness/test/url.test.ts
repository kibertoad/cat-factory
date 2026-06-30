import { describe, expect, it, vi } from 'vitest'
import {
  buildUrl,
  extractGatewayAddress,
  extractLoadBalancerAddress,
  resolveLiveUrl,
} from '../src/url.js'
import type { UrlSourceSpec } from '../src/job.js'

describe('extractLoadBalancerAddress', () => {
  it('reads a hostname over an ip, and null when unassigned', () => {
    expect(
      extractLoadBalancerAddress({
        status: { loadBalancer: { ingress: [{ hostname: 'lb.example' }] } },
      }),
    ).toBe('lb.example')
    expect(
      extractLoadBalancerAddress({ status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } } }),
    ).toBe('1.2.3.4')
    expect(extractLoadBalancerAddress({ status: { loadBalancer: { ingress: [] } } })).toBeNull()
    expect(extractLoadBalancerAddress(null)).toBeNull()
  })
})

describe('extractGatewayAddress', () => {
  it('reads the first status address value', () => {
    expect(extractGatewayAddress({ status: { addresses: [{ value: '203.0.113.5' }] } })).toBe(
      '203.0.113.5',
    )
    expect(extractGatewayAddress({ status: { addresses: [] } })).toBeNull()
  })
})

describe('buildUrl', () => {
  it('defaults to https and honors port + scheme', () => {
    expect(buildUrl('host.example', undefined)).toBe('https://host.example')
    expect(buildUrl('host.example', 'http')).toBe('http://host.example')
    expect(buildUrl('1.2.3.4', 'http', 8080)).toBe('http://1.2.3.4:8080')
    expect(buildUrl(null, 'https')).toBeNull()
  })
})

describe('resolveLiveUrl', () => {
  it('returns null for ingressTemplate (resolved backend-side)', async () => {
    const getJson = vi.fn()
    expect(await resolveLiveUrl({ source: 'ingressTemplate' }, 'ns', getJson)).toBeNull()
    expect(getJson).not.toHaveBeenCalled()
  })

  it('reads a Gateway listener hostname over its raw address', async () => {
    const url: UrlSourceSpec = { source: 'gatewayStatus', gatewayName: 'gw' }
    const getJson = vi.fn().mockResolvedValue({
      spec: { listeners: [{ hostname: 'app.preview.example' }] },
      status: { addresses: [{ value: '203.0.113.5' }] },
    })
    expect(await resolveLiveUrl(url, 'ns', getJson)).toBe('https://app.preview.example')
    expect(getJson).toHaveBeenCalledWith(['get', 'gateway', 'gw', '-n', 'ns', '-o', 'json'])
  })

  it('falls back to the Gateway address when no listener hostname (unnamed ⇒ list query)', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValue({ items: [{ status: { addresses: [{ value: '203.0.113.5' }] } }] })
    expect(await resolveLiveUrl({ source: 'gatewayStatus' }, 'ns', getJson)).toBe(
      'https://203.0.113.5',
    )
    expect(getJson).toHaveBeenCalledWith(['get', 'gateway', '-n', 'ns', '-o', 'json'])
  })

  it('resolves an HTTPRoute hostname directly', async () => {
    const getJson = vi.fn().mockResolvedValue({ spec: { hostnames: ['route.example'] } })
    expect(
      await resolveLiveUrl({ source: 'httpRouteStatus', httpRouteName: 'r' }, 'ns', getJson),
    ).toBe('https://route.example')
  })

  it('resolves an HTTPRoute via its parent Gateway when it has no hostname', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ spec: { parentRefs: [{ name: 'gw' }] } }] })
      .mockResolvedValueOnce({ status: { addresses: [{ value: '198.51.100.7' }] } })
    expect(await resolveLiveUrl({ source: 'httpRouteStatus' }, 'ns', getJson)).toBe(
      'https://198.51.100.7',
    )
    expect(getJson).toHaveBeenNthCalledWith(1, ['get', 'httproute', '-n', 'ns', '-o', 'json'])
    expect(getJson).toHaveBeenNthCalledWith(2, ['get', 'gateway', 'gw', '-n', 'ns', '-o', 'json'])
  })

  it('reads a Service LoadBalancer address with its port', async () => {
    const url: UrlSourceSpec = {
      source: 'serviceStatus',
      serviceName: 'svc',
      port: 8080,
      scheme: 'http',
    }
    const getJson = vi
      .fn()
      .mockResolvedValue({ status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } } })
    expect(await resolveLiveUrl(url, 'ns', getJson)).toBe('http://1.2.3.4:8080')
  })

  it('skips a wildcard Gateway listener hostname in favor of the concrete address', async () => {
    const getJson = vi.fn().mockResolvedValue({
      spec: { listeners: [{ hostname: '*.preview.example' }] },
      status: { addresses: [{ value: '203.0.113.5' }] },
    })
    expect(
      await resolveLiveUrl({ source: 'gatewayStatus', gatewayName: 'gw' }, 'ns', getJson),
    ).toBe('https://203.0.113.5')
  })

  it('skips a wildcard HTTPRoute hostname in favor of the parent Gateway address', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({
        spec: { hostnames: ['*.apps.example'], parentRefs: [{ name: 'gw' }] },
      })
      .mockResolvedValueOnce({ status: { addresses: [{ value: '198.51.100.7' }] } })
    expect(
      await resolveLiveUrl({ source: 'httpRouteStatus', httpRouteName: 'r' }, 'ns', getJson),
    ).toBe('https://198.51.100.7')
  })

  it('reads the parent Gateway in the parentRef namespace when it differs from the route', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({ spec: { parentRefs: [{ name: 'gw', namespace: 'istio-system' }] } })
      .mockResolvedValueOnce({ status: { addresses: [{ value: '198.51.100.9' }] } })
    expect(
      await resolveLiveUrl({ source: 'httpRouteStatus', httpRouteName: 'r' }, 'ns', getJson),
    ).toBe('https://198.51.100.9')
    expect(getJson).toHaveBeenNthCalledWith(1, ['get', 'httproute', 'r', '-n', 'ns', '-o', 'json'])
    expect(getJson).toHaveBeenNthCalledWith(2, [
      'get',
      'gateway',
      'gw',
      '-n',
      'istio-system',
      '-o',
      'json',
    ])
  })
})

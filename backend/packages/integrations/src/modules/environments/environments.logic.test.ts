import { describe, expect, it } from 'vitest'
import type { UrlSafetyPolicy } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { assertSafeAtlassianBaseUrl } from '@cat-factory/kernel'
import { frontendOriginsForService } from '@cat-factory/contracts'
import {
  assertSafeEnvironmentUrl,
  type EnvironmentIdentity,
  interpolateTemplate,
  shouldTeardownSuperseded,
} from './environments.logic.js'

// SSRF host-classification regression tests (Finding #6b). The guards must block
// the obfuscated loopback/link-local/RFC1918 encodings that bypass a naive
// dotted-decimal match, while leaving ordinary public hosts untouched.

const expectBlocked = (url: string) => {
  expect(() => assertSafeEnvironmentUrl(url), url).toThrow(ValidationError)
  expect(() => assertSafeAtlassianBaseUrl(url), url).toThrow(ValidationError)
}

const expectAllowed = (url: string) => {
  expect(() => assertSafeEnvironmentUrl(url), url).not.toThrow()
  expect(() => assertSafeAtlassianBaseUrl(url), url).not.toThrow()
}

describe('frontendOrigins CORS injection (deployer input → HTTP-manifest template)', () => {
  it('renders the derived frontend origins into a manifest body via {{input.frontendOrigins}}', () => {
    // The HTTP manifest provider uses the `{{input.*}}` namespace (vs the K8s adapter's flat
    // `{{frontendOrigins}}`). Same reverse-origin value, so an operator's provision `bodyTemplate`
    // can hand the backend the origins to allow (CORS).
    const origins = frontendOriginsForService('blk_api', [
      {
        level: 'frame',
        type: 'frontend',
        frontendConfig: {
          backendBindings: [
            { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
          ],
        },
      },
    ]).join(',')
    const rendered = interpolateTemplate('{"cors":"{{input.frontendOrigins}}"}', {
      input: { frontendOrigins: origins },
      provision: {},
    })
    expect(rendered).toBe('{"cors":"http://localhost:4173"}')
  })
})

describe('SSRF host guard — obfuscated internal targets', () => {
  it('blocks bare-integer IPv4 (decimal 127.0.0.1)', () => {
    expectBlocked('https://2130706433')
  })

  it('blocks hex-encoded octets', () => {
    expectBlocked('https://0x7f.0.0.1')
    expectBlocked('https://0x7f000001')
  })

  it('blocks octal / leading-zero octets', () => {
    expectBlocked('https://0177.0.0.1')
  })

  it('blocks IPv4-mapped IPv6 with private embedded v4', () => {
    expectBlocked('https://[::ffff:169.254.169.254]')
    expectBlocked('https://[::ffff:127.0.0.1]')
    // hex-group form of 169.254.169.254
    expectBlocked('https://[::ffff:a9fe:a9fe]')
  })

  it('blocks plain dotted-decimal private / loopback / link-local ranges', () => {
    expectBlocked('https://127.0.0.1')
    expectBlocked('https://10.0.0.5')
    expectBlocked('https://192.168.1.1')
    expectBlocked('https://172.16.0.1')
    expectBlocked('https://169.254.169.254')
    expectBlocked('https://0.0.0.0')
  })

  it('blocks IPv6 loopback / link-local / unique-local literals', () => {
    expectBlocked('https://[::1]')
    expectBlocked('https://[fe80::1]')
    expectBlocked('https://[fc00::1]')
    expectBlocked('https://[fd00::1]')
  })

  it('blocks localhost and internal suffixes', () => {
    expectBlocked('https://localhost')
    expectBlocked('https://svc.internal')
    expectBlocked('https://svc.local')
  })

  it('blocks malformed all-numeric dotted hosts', () => {
    expectBlocked('https://999.1.1.1')
  })
})

describe('SSRF host guard — legitimate public hosts unchanged', () => {
  it('allows ordinary public hostnames', () => {
    expectAllowed('https://your-team.atlassian.net')
    expectAllowed('https://api.example.com/path?q=1')
    expectAllowed('https://fcbank.com')
    expectAllowed('https://example123.io')
  })

  it('allows public dotted-decimal IPv4', () => {
    expectAllowed('https://8.8.8.8')
    expectAllowed('https://1.1.1.1')
  })
})

describe('SSRF host guard — scheme and credential rules', () => {
  it('rejects non-https', () => {
    expect(() => assertSafeEnvironmentUrl('http://example.com')).toThrow(ValidationError)
    expect(() => assertSafeAtlassianBaseUrl('http://example.com')).toThrow(ValidationError)
  })

  it('rejects embedded credentials', () => {
    expect(() => assertSafeEnvironmentUrl('https://user:pass@example.com')).toThrow(ValidationError)
    expect(() => assertSafeAtlassianBaseUrl('https://user:pass@example.com')).toThrow(
      ValidationError,
    )
  })
})

describe('URL safety policy — trusted internal-host widening', () => {
  const internalHosts: UrlSafetyPolicy = { schemes: ['https'], allowHosts: ['.internal', 'kargo'] }
  const httpAndHosts: UrlSafetyPolicy = {
    schemes: ['https', 'http'],
    allowHosts: ['.corp', '10.1.2.3'],
  }

  it('still rejects internal hosts under the strict default', () => {
    expect(() => assertSafeEnvironmentUrl('https://kargo.internal')).toThrow(ValidationError)
    expect(() => assertSafeEnvironmentUrl('https://10.1.2.3')).toThrow(ValidationError)
    expect(() => assertSafeEnvironmentUrl('http://kargo')).toThrow(ValidationError)
  })

  it('allows an exact-match exempt host', () => {
    expect(() => assertSafeEnvironmentUrl('https://kargo', 'base URL', internalHosts)).not.toThrow()
  })

  it('allows a dot-suffix exempt host (and its sub-hosts)', () => {
    expect(() =>
      assertSafeEnvironmentUrl('https://prenv.kargo.internal', 'base URL', internalHosts),
    ).not.toThrow()
    // The bare suffix host itself (`internal`) also matches `.internal`.
    expect(() =>
      assertSafeEnvironmentUrl('https://internal', 'base URL', internalHosts),
    ).not.toThrow()
  })

  it('permits http and an exempt private IP when the policy allows them', () => {
    expect(() =>
      assertSafeEnvironmentUrl('http://app.corp/path', 'base URL', httpAndHosts),
    ).not.toThrow()
    expect(() =>
      assertSafeEnvironmentUrl('https://10.1.2.3', 'base URL', httpAndHosts),
    ).not.toThrow()
  })

  it('does not widen non-exempt hosts or schemes', () => {
    // A private IP not in the allow-list is still blocked.
    expect(() => assertSafeEnvironmentUrl('https://10.9.9.9', 'base URL', internalHosts)).toThrow(
      ValidationError,
    )
    // http is still rejected when the policy only permits https.
    expect(() => assertSafeEnvironmentUrl('http://kargo', 'base URL', internalHosts)).toThrow(
      ValidationError,
    )
  })

  it('forbids embedded credentials regardless of policy', () => {
    expect(() => assertSafeEnvironmentUrl('https://u:p@kargo', 'base URL', internalHosts)).toThrow(
      ValidationError,
    )
  })
})

describe('shouldTeardownSuperseded', () => {
  const k8s = (externalId: string | null): EnvironmentIdentity => ({
    provisionType: 'kubernetes',
    engine: 'remote-kubernetes',
    externalId,
  })

  it('never tears down a prior with no real infra (null externalId)', () => {
    // A `provisioning`/`failed` placeholder row provisioned nothing — nothing to reclaim.
    expect(shouldTeardownSuperseded(k8s(null), k8s('cf-env-new'))).toBe(false)
    expect(shouldTeardownSuperseded(k8s(null), null)).toBe(false)
  })

  it('tears down when nothing replaces it (the infraless flip)', () => {
    expect(shouldTeardownSuperseded(k8s('cf-env-old'), null)).toBe(true)
  })

  it('tears down on a provider/type change', () => {
    const next: EnvironmentIdentity = {
      provisionType: 'custom',
      engine: 'remote-custom',
      externalId: null,
    }
    expect(shouldTeardownSuperseded(k8s('cf-env-old'), next)).toBe(true)
  })

  it('tears down on an engine change within the same type', () => {
    const next: EnvironmentIdentity = {
      provisionType: 'kubernetes',
      engine: 'local-k3s',
      externalId: null,
    }
    expect(shouldTeardownSuperseded(k8s('cf-env-old'), next)).toBe(true)
  })

  it('tears down when the new external id (namespace) is known and differs', () => {
    expect(shouldTeardownSuperseded(k8s('cf-env-old'), k8s('cf-env-new'))).toBe(true)
  })

  it('keeps the deterministic overwrite-in-place: same type/engine, same external id', () => {
    expect(shouldTeardownSuperseded(k8s('cf-env-1'), k8s('cf-env-1'))).toBe(false)
  })

  it('is conservative when the new external id is not yet known (async placeholder)', () => {
    // The async `provisioning` insert has externalId=null; a matching type/engine ⇒ assume the
    // deterministic same-namespace overwrite, so do NOT tear down (the TTL reaper is the backstop).
    expect(shouldTeardownSuperseded(k8s('cf-env-1'), k8s(null))).toBe(false)
  })
})

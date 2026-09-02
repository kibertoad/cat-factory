import { describe, expect, it } from 'vitest'
import type { UrlSafetyPolicy } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { assertSafeAtlassianBaseUrl } from '@cat-factory/kernel'
import { frontendOriginsForService } from '@cat-factory/contracts'
import {
  assertSafeEnvironmentUrl,
  boundStatusNote,
  describeMisresolvingEnvironmentUrl,
  type EnvironmentIdentity,
  interpolateTemplate,
  extractAddresses,
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
  const internalHosts: UrlSafetyPolicy = {
    schemes: ['https'],
    allowHosts: ['.internal', 'acme-envs'],
  }
  const httpAndHosts: UrlSafetyPolicy = {
    schemes: ['https', 'http'],
    allowHosts: ['.corp', '10.1.2.3'],
  }

  it('still rejects internal hosts under the strict default', () => {
    expect(() => assertSafeEnvironmentUrl('https://envs.internal')).toThrow(ValidationError)
    expect(() => assertSafeEnvironmentUrl('https://10.1.2.3')).toThrow(ValidationError)
    expect(() => assertSafeEnvironmentUrl('http://acme-envs')).toThrow(ValidationError)
  })

  it('allows an exact-match exempt host', () => {
    expect(() =>
      assertSafeEnvironmentUrl('https://acme-envs', 'base URL', internalHosts),
    ).not.toThrow()
  })

  it('allows a dot-suffix exempt host (and its sub-hosts)', () => {
    expect(() =>
      assertSafeEnvironmentUrl('https://box.envs.internal', 'base URL', internalHosts),
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
    expect(() => assertSafeEnvironmentUrl('http://acme-envs', 'base URL', internalHosts)).toThrow(
      ValidationError,
    )
  })

  it('forbids embedded credentials regardless of policy', () => {
    expect(() =>
      assertSafeEnvironmentUrl('https://u:p@acme-envs', 'base URL', internalHosts),
    ).toThrow(ValidationError)
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

describe('describeMisresolvingEnvironmentUrl', () => {
  it('refuses the composition that cost a run its tester step', () => {
    // `cf-acc-5` is the per-PR namespace for pull request 5 in front of the loopback host the k3s
    // doc recommends. It resolves to 5.127.0.0, which is not the cluster that rolled out.
    const refusal = describeMisresolvingEnvironmentUrl('http://cf-acc-5.127.0.0.1.nip.io')
    expect(refusal).toContain('5.127.0.0')
    expect(refusal).toContain('127.0.0.1')
    expect(refusal).toContain('manifests, which are correct')
  })

  it('reads the host out of a URL carrying a port', () => {
    expect(describeMisresolvingEnvironmentUrl('http://cf-acc-5.127.0.0.1.nip.io:18080')).toContain(
      '5.127.0.0',
    )
  })

  it.each([
    // The same cluster, addressed by a namespace whose last label ends in a letter.
    'http://cf-env-catalog-api-pr5.127.0.0.1.nip.io',
    // An ordinary hostname, whatever digits it carries.
    'http://env-5.preview.example.com',
    // A LoadBalancer address, the other URL source.
    'http://192.168.1.40',
    // A bracketed IPv6 literal, which carries no name to mis-read.
    'http://[2001:db8::1]:8080',
  ])('passes %s', (url) => {
    expect(describeMisresolvingEnvironmentUrl(url)).toBeNull()
  })

  it('leaves an unparseable URL to the policy that already refuses it', () => {
    // Answering here would put a DNS note in front of a failure that is not about DNS.
    expect(describeMisresolvingEnvironmentUrl('not a url')).toBeNull()
  })
})

describe('boundStatusNote', () => {
  it('trims, and reads a blank note as nothing said', () => {
    expect(boundStatusNote('  the deploy job is queued  ')).toBe('the deploy job is queued')
    expect(boundStatusNote('   ')).toBeNull()
    expect(boundStatusNote(null)).toBeNull()
    expect(boundStatusNote(undefined)).toBeNull()
  })

  it('leaves an ordinary note byte-for-byte alone', () => {
    // The built-in notes are one sentence; the cap exists for a third-party adapter, and it may
    // not touch the shape a provider actually writes.
    const note = "2 of 3 Deployments are still rolling out: 'api', 'worker'"
    expect(boundStatusNote(note)).toBe(note)
  })

  it('bounds a provider that answers with a dump, and SAYS it was cut', () => {
    // A code adapter can return a controller dump or an event list. Stored whole it rides into
    // the run-failure message, the outcome card and a panel line beside a healthy environment.
    const bounded = boundStatusNote('x'.repeat(1200))!
    expect(bounded.length).toBeLessThan(500)
    // A capped value that trailed off would read as the provider's whole account.
    expect(bounded).toContain('note truncated: 800 of 1200 characters dropped')
    expect(bounded.startsWith('x'.repeat(400))).toBe(true)
  })
})

describe('extractAddresses', () => {
  const balancers = {
    data: {
      addresses: ['10.4.19.22', { address: '10.4.19.23', label: 'public ALB' }],
      names: ['alb-4.elb.example', { host: 'alb-9.elb.example', label: 'internal ALB' }],
    },
  }

  it('reads a bare string as whichever kind the DECLARED manifest key means', () => {
    // A bare string is unlabelled, so nothing about the VALUE says whether it is an address or a
    // name someone is about to resolve. Which manifest key was declared is what says so, and
    // guessing would be the one place the bridge rule rests on a parse.
    expect(extractAddresses(balancers, 'data.addresses')).toEqual([
      { address: '10.4.19.22' },
      { address: '10.4.19.23', label: 'public ALB' },
    ])
    expect(extractAddresses(balancers, 'data.names', 'host')).toEqual([
      { host: 'alb-4.elb.example' },
      { host: 'alb-9.elb.example', label: 'internal ALB' },
    ])
  })

  it('reads an OBJECT entry as it is written, so ONE path can interleave both kinds', () => {
    // The only shape that can express a provider's preference order across the two, which is the
    // reason the manifest offers a second path rather than a second list on the port.
    expect(
      extractAddresses({ out: [{ host: 'alb-4.elb.example' }, { address: '10.4.19.30' }] }, 'out'),
    ).toEqual([{ host: 'alb-4.elb.example' }, { address: '10.4.19.30' }])
  })

  it('drops an entry naming both or neither, rather than carrying one the plan can only refuse', () => {
    expect(
      extractAddresses(
        { out: [{ address: '10.4.19.30', host: 'alb.example' }, { label: 'nothing' }, 42] },
        'out',
      ),
    ).toEqual([])
  })

  it('reads nothing at all for a path the manifest does not declare', () => {
    expect(extractAddresses(balancers, undefined)).toEqual([])
    expect(extractAddresses(balancers, 'data.missing')).toEqual([])
  })
})

import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { KUBERNETES_RUNNER_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
import { describeConnectionFailure } from '@cat-factory/kernel'
import type { SecretResolver } from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KubernetesApiClient } from './KubernetesApiClient.js'

// WIRE coverage for the CUSTOM-TLS path, over a real TLS socket (no cluster, runs in the unit
// lane). The mocked-fetch unit tests around this client stub `fetch` and therefore cannot see the
// half that broke: a custom CA / skip-verify config makes the client build an undici `Agent` and
// dispatch THROUGH it, and a dispatcher only works with a `fetch` from the same undici instance.
// Handing the userland Agent to Node's global `fetch` (whose handler comes from Node's own bundled
// undici) failed every apiserver call before a socket was opened, with `invalid onRequestStart
// method (UND_ERR_INVALID_ARG)` — which reads on a connect form as an unreachable cluster. A k3s
// apiserver serves a self-signed certificate, so that is the config k3s needs and k3s could not be
// connected at all.
//
// The third case is what makes the first two mean something: it pins that verification is really
// happening, so a future "fix" that reached green by dropping the TLS options fails here.

/**
 * A throwaway self-signed certificate + key for 127.0.0.1, generated for these tests alone and
 * valid until 2126 (an expiring fixture is a test that fails on a date rather than on a change).
 * It serves as its own CA, which is exactly the shape a k3s apiserver presents.
 */
const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUDSjdyAA0SlLvHkMIIG64/kSaWDQwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZY2F0LWZhY3RvcnktazhzLXdpcmUtdGVzdDAgFw0yNjA4MDky
MzQ5NTVaGA8yMTI2MDcxNjIzNDk1NVowJDEiMCAGA1UEAwwZY2F0LWZhY3Rvcnkt
azhzLXdpcmUtdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABG5VQCdyBHQ6
PhUIuFN7Ah6Yi339splONZiRQ2T5kf2x8DPGW5DY6KCeakTxBLel/+LS+bBW3bhI
C3GL2/osXBajZDBiMB0GA1UdDgQWBBRS4H2u+wOmTJTzgqihqnMjGMEFNDAfBgNV
HSMEGDAWgBRS4H2u+wOmTJTzgqihqnMjGMEFNDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgAVWFmBrbcLmhFUvx+DpH
o+9tryzhULrgJnHnTQMtcH0CIQCSv8SfFHHRPEOP2VSULzy7W4AJXIbs9hLCtHlX
D7YVtg==
-----END CERTIFICATE-----
`

const SERVER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOyFwubc/A+uFwm0O
kPxyQK+j9z7v5qBRau40nbrWRCuhRANCAARuVUAncgR0Oj4VCLhTewIemIt9/bKZ
TjWYkUNk+ZH9sfAzxluQ2OignmpE8QS3pf/i0vmwVt24SAtxi9v6LFwW
-----END PRIVATE KEY-----
`

/** An unrelated self-signed CA: trust material that does NOT vouch for the server above. */
const UNRELATED_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUErbQbjZX1vbdfyq5I6PifvhoqOowCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYY2F0LWZhY3RvcnktdW5yZWxhdGVkLWNhMCAXDTI2MDgwOTIz
NDk1NVoYDzIxMjYwNzE2MjM0OTU1WjAjMSEwHwYDVQQDDBhjYXQtZmFjdG9yeS11
bnJlbGF0ZWQtY2EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT5ByzSBJR+aq/v
fqxFGQimrlAQ/ZG0F6EsYAh+gJoWSCmpxaWYJsJH1vKq3W2F4+6UTn8GiJvHyu2Q
b9SfXVk7o2QwYjAdBgNVHQ4EFgQUSh0KOHGMLd6I2o8c/t6eegiDZlQwHwYDVR0j
BBgwFoAUSh0KOHGMLd6I2o8c/t6eegiDZlQwDwYDVR0TAQH/BAUwAwEB/zAPBgNV
HREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUCIDF9gYNdzgWJxhZIlxNrVa3f
EPLVlH/kxEZ9BCSct3/WAiEAvDTOhfpYgB9QEzyI1RJfTLi+WpIXRMl2dNnaWT0F
mP0=
-----END CERTIFICATE-----
`

const TOKEN = 'wire-test-token'
const SECRETS: SecretResolver = (key) =>
  key === KUBERNETES_RUNNER_TOKEN_SECRET_KEY ? TOKEN : undefined

const TIMEOUT_MS = 5_000

describe('KubernetesApiClient custom-TLS wire seam', () => {
  let server: Server
  let apiServerUrl: string
  let received: { authorization?: string }

  beforeEach(async () => {
    received = {}
    server = createServer({ cert: SERVER_CERT_PEM, key: SERVER_KEY_PEM }, (req, res) => {
      received.authorization = req.headers.authorization
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ kind: 'PodList', items: [] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    apiServerUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    // Keep-alive sockets from the Agent would otherwise hold `close()` open until the idle timeout.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reaches an apiserver whose certificate is vouched for by the configured CA', async () => {
    const client = new KubernetesApiClient({ apiServerUrl, caCertPem: SERVER_CERT_PEM }, SECRETS)

    const res = await client.fetch('GET', `${apiServerUrl}/api/v1/pods`, undefined, TIMEOUT_MS)

    expect(res.status).toBe(200)
    // The request really carried the client's own headers, so this is the whole path and not a
    // bare socket check.
    expect(received.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('reaches an apiserver with TLS verification skipped', async () => {
    const client = new KubernetesApiClient({ apiServerUrl, insecureSkipTlsVerify: true }, SECRETS)

    const res = await client.fetch('GET', `${apiServerUrl}/api/v1/pods`, undefined, TIMEOUT_MS)

    expect(res.status).toBe(200)
    expect(received.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('refuses a certificate the configured CA does not vouch for', async () => {
    const client = new KubernetesApiClient({ apiServerUrl, caCertPem: UNRELATED_CA_PEM }, SECRETS)

    const error = await client
      .fetch('GET', `${apiServerUrl}/api/v1/pods`, undefined, TIMEOUT_MS)
      .then(() => undefined)
      .catch((err: unknown) => err)

    expect(error).toBeDefined()
    // Classified as untrusted trust material, which is what sends the operator to the CA field.
    // Anything else here (an argument error, say) means the request died short of the handshake.
    expect(describeConnectionFailure(error).cause).toBe('tls-untrusted')
  })
})

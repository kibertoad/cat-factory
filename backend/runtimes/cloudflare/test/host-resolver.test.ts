import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerHostResolver } from '../src/infrastructure/hostResolver'

// The Worker facade's `HostResolver`, which is the only one of the two adapters with real logic of
// its own: workerd exposes no resolver, so this one speaks DNS-over-HTTPS and has to read a third
// party's JSON. Every case below is a way that read can be wrong in a direction that matters.
//
// `fetch` is stubbed rather than reached: a unit test that made a real lookup would assert what
// the machine's network says today.

/** One DoH JSON answer, as `cloudflare-dns.com` returns it. */
const answer = (status: number, records: { type: number; data: string }[]) =>
  new Response(JSON.stringify({ Status: status, Answer: records }), { status: 200 })

const stubFetch = (byType: Record<string, Response | (() => Response)>) =>
  vi.stubGlobal('fetch', async (input: string) => {
    const type = new URL(input).searchParams.get('type') ?? ''
    const entry = byType[type]
    if (!entry) throw new Error(`unexpected DoH query for ${type}`)
    return typeof entry === 'function' ? entry() : entry
  })

afterEach(() => vi.unstubAllGlobals())

describe('workerHostResolver', () => {
  it('answers with every address, A ahead of AAAA', () => {
    // Both types, because an environment fronted by a dual-stack balancer publishes both and the
    // plan tries candidates in order: putting the family a runner is most likely to route first
    // costs nothing and saves a timeout.
    stubFetch({
      A: answer(0, [{ type: 1, data: '35.158.50.136' }]),
      AAAA: answer(0, [{ type: 28, data: '2a05:d014::1' }]),
    })
    return expect(workerHostResolver({ host: 'alb.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'resolved',
      addresses: ['35.158.50.136', '2a05:d014::1'],
    })
  })

  it('ignores a CNAME record rather than handing the plan a NAME to dial', () => {
    // A CNAME chain arrives inline in the same `Answer` array. Read as an address it would reach
    // `isBridgeableAddress`, be refused as a non-canonical literal, and report an ordinary alias
    // as an address the platform will not dial.
    stubFetch({
      A: answer(0, [
        { type: 5, data: 'alb-4.eu-central-1.elb.amazonaws.com.' },
        { type: 1, data: '35.158.50.136' },
      ]),
      AAAA: answer(0, []),
    })
    return expect(workerHostResolver({ host: 'alb.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'resolved',
      addresses: ['35.158.50.136'],
    })
  })

  it('reads NXDOMAIN as the name answering NOTHING, which is a fact about the name', () => {
    // The one outcome here that establishes anything: that candidate is a dead end, so the proof
    // may settle on it. Reported as a failure it would leave the route unruled-out forever.
    stubFetch({ A: answer(3, []), AAAA: answer(3, []) })
    return expect(workerHostResolver({ host: 'gone.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'unresolved',
    })
  })

  it('keeps a PARTIAL answer, so a missing AAAA cannot cost a dialable balancer', () => {
    stubFetch({
      A: answer(0, [{ type: 1, data: '35.158.50.136' }]),
      AAAA: () => new Response('nope', { status: 502 }),
    })
    return expect(workerHostResolver({ host: 'alb.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'resolved',
      addresses: ['35.158.50.136'],
    })
  })

  it('says it could not TELL when neither type could be asked, and never that the name is gone', () => {
    // A resolver outage graded as "this balancer does not exist" is how an upstream blip becomes a
    // recorded verdict about somebody's environment.
    stubFetch({
      A: () => new Response('down', { status: 503 }),
      AAAA: () => new Response('down', { status: 503 }),
    })
    return expect(
      workerHostResolver({ host: 'alb.example', timeoutMs: 500 }),
    ).resolves.toMatchObject({ state: 'failed' })
  })

  it('never REJECTS, whatever the transport does', () => {
    // The port's contract. A thrown resolver would turn a diagnostic into a second way for a
    // healthy run to die, where `failed` says "we could not tell" on the record.
    vi.stubGlobal('fetch', async () => {
      throw new Error('subrequest limit exceeded')
    })
    return expect(
      workerHostResolver({ host: 'alb.example', timeoutMs: 500 }),
    ).resolves.toMatchObject({ state: 'failed', detail: expect.stringContaining('subrequest') })
  })

  it('reads a non-zero, non-NXDOMAIN status as an answer it cannot use', () => {
    // SERVFAIL and friends. The resolver declined to say, which is not the same as saying nothing.
    stubFetch({ A: answer(2, []), AAAA: answer(2, []) })
    return expect(
      workerHostResolver({ host: 'alb.example', timeoutMs: 500 }),
    ).resolves.toMatchObject({ state: 'failed', detail: expect.stringContaining('status 2') })
  })
})

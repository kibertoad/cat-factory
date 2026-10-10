import { describe, expect, it } from 'vitest'
import { redactImagePayloads } from './redact-image-payloads.logic.js'

describe('redactImagePayloads', () => {
  it('describes a typed-array payload instead of serialising it byte by byte', () => {
    // The failure this exists to prevent: `JSON.stringify` renders a Uint8Array as one entry PER
    // BYTE, so a half-megabyte frame lands as megabytes of telemetry on every turn.
    const body = [{ role: 'user', content: [{ type: 'image', image: new Uint8Array(1024) }] }]
    const json = JSON.stringify(redactImagePayloads(body))
    expect(json).toContain('1024 bytes')
    expect(json).not.toContain('"0":0')
    expect(json.length).toBeLessThan(200)
  })

  it('describes an inline data: URL and keeps its media type', () => {
    const body = { messages: [{ image_url: { url: 'data:image/png;base64,AAAABBBBCCCC' } }] }
    const redacted = redactImagePayloads(body)
    expect(redacted.messages[0]!.image_url.url).toBe('<binary image/png withheld: 12 bytes>')
  })

  it('leaves a REMOTE image url alone', () => {
    // A link is how a reader finds the picture again; only the inlined bytes are the problem.
    const url = 'https://cdn.example.com/frames/checkout.png'
    expect(redactImagePayloads({ url })).toEqual({ url })
  })

  it('leaves ordinary prose alone however long it is', () => {
    // The record this subsystem exists to keep IS the prompt: redacting a long one would be a
    // far worse bug than the one being fixed.
    const text = 'Build the checkout screen. '.repeat(500)
    expect(redactImagePayloads({ text })).toEqual({ text })
  })

  it('preserves the message structure around what it replaces', () => {
    const body = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', image: new Uint8Array(4) },
        ],
      },
    ]
    const redacted = redactImagePayloads(body)
    expect(redacted[0]!.role).toBe('user')
    expect(redacted[0]!.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(redacted[0]!.content[1]!.type).toBe('image')
  })

  it('does not mutate the body it was handed', () => {
    // It runs beside the request being sent, not instead of it.
    const image = new Uint8Array(8)
    const body = [{ content: [{ image }] }]
    redactImagePayloads(body)
    expect(body[0]!.content[0]!.image).toBe(image)
  })
})

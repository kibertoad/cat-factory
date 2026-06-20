// Pure base64 encoder for ASCII credentials (HTTP Basic auth). Avoids depending on
// `btoa` (DOM lib) or `Buffer` (Node lib) so this package stays runtime-neutral.
// Jira account emails + API tokens are ASCII, so a byte-per-char encode is correct.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i += 3) {
    const b0 = input.charCodeAt(i) & 0xff
    const b1 = i + 1 < input.length ? input.charCodeAt(i + 1) & 0xff : 0
    const b2 = i + 2 < input.length ? input.charCodeAt(i + 2) & 0xff : 0
    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < input.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < input.length ? ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

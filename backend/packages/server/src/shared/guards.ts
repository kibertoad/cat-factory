// Shape guards for untrusted JSON, shared by every reader of a parsed body (the MCP probe's
// frames, the machine-API wire decoders) so each reader means the same thing by "an object".

/** A plain JSON object: not null, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

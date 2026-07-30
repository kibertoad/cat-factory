import { parse as parseYaml, parseAllDocuments } from 'yaml'

// The YAML / loose-value primitives every provisioning detector is built on: "is this a YAML
// file", the three `unknown` narrowings that make parsed YAML safe to walk, and the two parses
// (multi-doc and single-doc) that swallow a malformed file into an empty result rather than
// failing a whole scan. Split out of `provision-detect.logic.ts` so the Kubernetes half can sit
// in its own module without either importing the other's detector.

export function isYamlFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml')
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function parseDocs(content: string): Record<string, unknown>[] {
  try {
    return parseAllDocuments(content)
      .map((d) => d.toJS() as unknown)
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => r !== null)
  } catch {
    return []
  }
}

export function parseOne(content: string): Record<string, unknown> | null {
  try {
    return asRecord(parseYaml(content) as unknown)
  } catch {
    return null
  }
}

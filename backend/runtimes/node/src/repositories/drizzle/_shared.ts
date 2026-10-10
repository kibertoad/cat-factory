// Shared Drizzle repository helpers used across more than one domain file.

export function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}
